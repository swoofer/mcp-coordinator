# C03 — Channels : aligner `cli/channel.ts` sur le contrat officiel `claude/channel`

| Champ | Valeur |
|---|---|
| **ID** | `channels-official-contract` |
| **Surface** | claude-code |
| **Statut** | research-preview — les deux pages de doc portent l'encart « Channels are in research preview » ; déploiement progressif ; la syntaxe de `--channels` et le contrat protocolaire peuvent encore changer |
| **Disponible depuis** | aucune date officielle publiée. Le seul jalon versionné cité par la doc est `v2.1.211` (assainissement des champs relayés). Les chercheurs ne datent que leur propre observation (août 2026). |
| **Tier** | T1-incontournable |
| **Nature** | replace-homemade-code (avec une composante `threat` réelle sur la distribution — voir §4) |
| **Effort estimé** | M — **confirmé au challenge 2026-08-16**, et le S des fiches brutes est bien faux. Décompte honnête : **8 à 10 fichiers**, l'écart venant entièrement de `docs/index.html` où une seule chaîne coûte **7 éditions** (1 inline + 6 langues). |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — ~~verrous org et allowlist officielle hors de portée locale~~ **révisé le 2026-08-16 : côté serveur seulement.** Le contrat hôte est **inatteignable depuis un agent** — `--dangerously-load-development-channels` n'est pas parsé hors session interactive (§6.4-K). |
| **Statut du challenge** | ✅ **tranché** (2026-08-16) — `reporter`, K1 et K6 déclenchés |

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

> 🔴 **Infirmé par le challenge du 2026-08-16.** La promesse ci-dessous — « cela tranche d'un coup »
> les quatre points — est **fausse**. La manipulation a été conduite dans les quatre modes headless
> disponibles et **aucun tag n'a jamais été injecté** : la surface channel ne s'active pas hors
> session interactive, et un agent ne peut pas répondre au dialogue d'avertissement plein écran.
> Les quatre points restent donc **ouverts**. La testabilité réelle de cette fiche est : ⚠️ partielle
> **côté serveur uniquement** — tout ce qui dépend de l'hôte exige un humain devant un terminal.
> Détail et adjudication des critères en §6.4-F et §6.4-J.

Testable ici *(promesse initiale du 2026-08-14, conservée pour mémoire)* : lancer `claude --dangerously-load-development-channels server:coordinator-channel` avec le `.mcp.json.sample` du quickstart, publier un événement MQTT sur le broker du daemon local, et capturer le tag réellement injecté — cela tranche d'un coup le désaccord de nommage, la valeur exacte de `source`, le sort d'une clé `meta` non-identifiant, et le retrait de `capabilities.experimental.tools` (relance de `tests/integration/channel-smoke.test.ts`). Non testable ici : tout ce qui dépend d'un tiers — l'allowlist Anthropic (`--channels plugin:…@claude-plugins-official` sans flag `dangerously`), les managed settings `channelsEnabled` / `allowedChannelPlugins` (exigent un org Team/Enterprise et le rôle Owner), et l'indisponibilité sur Bedrock / Google Cloud Agent Platform / Microsoft Foundry.

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

> 📍 **Recalés le 2026-08-16** contre `mcp-coordinator@2.1.0` (le dépôt a bougé, notamment la
> migration SDK v2) : `docs/usage.md` **l. 158** (et non 156) · `cli/channel.ts` **l. 96**
> (`consultation_new`, et non 97), **l. 157** (`INSTRUCTIONS`, et non 158), **l. 240**
> (`consultation_opened` dans la description d'outil), **l. 314-320** (bloc `capabilities`, et non
> 311-318) · `docs/operating-modes.md` **l. 125** (le tag d'exemple, et non 108).
> Le renommage `consultation_*` est aussi **plus large que ne le dit la ligne concernée** : outre
> `examples/channels-quickstart/README.md` l. 120, il est verrouillé par des tests —
> `tests/integration/channel-smoke.test.ts` l. 245 et `tests/unit/cli-channel.test.ts` l. 339 — et la
> variante `topic_kind: "consultation_opened"` traverse tout le harnais
> (`tests/helpers/channel-test-harness.ts` l. 27, `tests/unit/channel-harness-self-test.ts`,
> `tests/unit/fixtures/channel-stub-server.ts` l. 42).

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
| `README.md` l. 111-119 | 🔴 **§5 se trompait ici, corrigé le 2026-08-16.** La ligne de lancement n'est **pas** correcte : l. 111-112 renvoient explicitement à `examples/channels-quickstart/.mcp.json.sample` (clé `coordinator-channel`), puis l. 114 lance `server:mcp-coordinator-channel`. **C'est exactement le même bug qu'au quickstart, en deuxième exemplaire, sur la page d'accueil du projet.** S'y ajoute le « Channels-capable Claude Code (**v2.1.80+**) » l. 119 : aucune source du bundle ne mentionne v2.1.80 ; le seul numéro documenté est v2.1.211 (assainissement du relais). |
| `examples/channels-quickstart/README.md` l. 149-151 | 🆕 **Trouvé au challenge du 2026-08-16 — la table de dépannage envoie l'utilisateur dans le mur.** « Claude Code refuses to start » : il ne refuse pas, il démarre en silence (§6.4-A, mesuré). « No `<channel>` tags appear → daemon may be down » : le daemon n'y est pour rien, la cause réelle est une porte hôte (§6.4-D) qui ne journalise rien. Ce sont les deux lignes censées sauver l'utilisateur, et ce sont celles qui lui font perdre le plus de temps. |
| **Trois** noms de serveur concurrents dans le dépôt | 🆕 `coordinator-channel` (`.mcp.json.sample` l. 7 ; quickstart README l. 54, 60, 109) · `mcp-coordinator-channel` (quickstart README l. 80, 83 ; `docs/operating-modes.md` l. 81, 108, 117 ; `README.md` l. 114) · `mcp-coordinator` (`docs/operating-modes.md` l. 125, dans `source="…"`). `docs/operating-modes.md` est interne-cohérent, le quickstart et `README.md` ne le sont pas : **trancher le nom casse forcément la cohérence de l'un des deux documents**. |
| `docs/usage.md` l. 156 | Reprend le même « v2.1.80+ ». Même correction. |
| `cli/doctor.ts` | **Aucune** mention de « channel » (grep insensible à la casse : 0 résultat). Emplacement naturel d'un check « le nom `.mcp.json` correspond-il à ce qu'on documente dans `--channels server:<nom>` ? » — précisément le bug ci-dessus. |
| `tests/unit/cli-channel.test.ts` l. 133-149 | Assert déjà `experimental['claude/channel'] = {}`, `experimental.tools` et `tools` top-level. À étendre : assertion sur la forme des clés `meta`, et décision sur le sort de `experimental.tools`. |
| `tests/integration/channel-smoke.test.ts`, `tests/helpers/channel-test-harness.ts`, `tests/unit/channel-harness-self-test.ts` | Harnais existant qui capture les `notifications/claude/channel` d'un vrai client MCP. Suffisant pour tester le contrat côté serveur ; **ne teste rien** du côté hôte (allowlist, flags, rendu du tag). |
| `docs/superpowers/working/channels-reference-plugins-study.md` | Étude interne des plugins officiels (telegram, discord, imessage, fakechat), antérieure à la doc publique. Contient déjà la matrice de conformité (l. 245-250) et la recommandation de ne déclarer `claude/channel/permission` qu'avec authentification du répondeur (l. 396). À réconcilier avec la doc officielle : c'est la source de vérité *reverse-engineered* qu'on peut maintenant retirer ou marquer comme historique. |
| `docs/index.html` | 🔴 **Chiffré le 2026-08-16 : la clé `start.modes` apparaît 7 fois** (1 inline + 6 dictionnaires de langue). Son texte promet, sans la moindre réserve, que « coordination events arrive as `<channel>` tags in your Claude Code session between turns ». Deux autres blocs channels y sont aussi ×7 (`roadmap.v12.desc`, `roadmap.v13.desc`). **Toute correction de statut coûte 7 éditions par chaîne** — c'est le poste de coût que la fiche omettait. |
| `CHANGELOG.md` | Mentionne les channels ; chaque entrée trace vers l'issue `#130`, ouverte et fermée par le mainteneur lui-même. |
| ~~`SECURITY.md`~~ | 🔴 **Faux positif, retiré le 2026-08-16.** Ses trois occurrences de « channel » sont le mot ordinaire : « Preferred channel — GitHub private vulnerability reporting » (l. 21), « use the GitHub channel above » (l. 27), « channels (Discord, Slack, social media) » (l. 41). Aucun rapport avec la feature. |
| `tests/unit/fixtures/channel-stub-server.ts` l. 21-28 | 🆕 **Le dépôt se contredit tout seul** : le stub de test déclare `experimental: { "claude/channel": {} }` **sans** `experimental.tools` — exactement la forme du scaffold officiel d'Anthropic (§6.4-C), et l'inverse de `cli/channel.ts`. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Faut-il empaqueter le channel en **plugin sur un marketplace** (`plugin:<nom>@<marketplace>`) pour viser une entrée `allowedChannelPlugins` chez les admins clients et, à terme, l'allowlist Anthropic via un contact partenaire — ou assumer définitivement l'entrée `server:<nom>` derrière `--dangerously-load-development-channels` et investir l'effort équivalent dans un chemin de push **indépendant de Claude Code** (le bus MQTT existant, ou une inbox), sachant que ni l'un ni l'autre ne débloque Bedrock / Google Cloud Agent Platform / Microsoft Foundry ?

### 6.2 Hypothèse

*Pré-enregistrée le 2026-08-16, **avant** toute exécution.*

**Ce que je crois qu'il va se passer.**

1. Le channel se charge avec `server:coordinator-channel` (la **clé `.mcp.json`**) et **pas** avec
   `server:mcp-coordinator-channel` (`serverInfo.name`). Le `.mcp.json.sample` a raison, le README
   du quickstart a tort — le quickstart est donc cassé pour de vrai, pas seulement incohérent.
2. Le tag injecté porte `source="coordinator-channel"`. L'attribut `name` montré au quickstart
   l. 109 est une invention maison.
3. Une clé `meta` non-identifiant (`target-modules`) fait disparaître **l'attribut entier**, en
   silence — conformément au contrat officiel, et contre l'affirmation « le tiret est retiré ».
4. Retirer `capabilities.experimental.tools` ne casse rien : le SDK ne consulte que
   `capabilities.tools` pour autoriser `tools/call`.
5. Le « v2.1.80+ » n'est sourçable nulle part → à retirer plutôt qu'à graver.

**Verdict pressenti :** `adopter partiellement` — garde-fou sur les clés `meta` + correctif du
quickstart cassé, en **refusant** l'empaquetage plugin de §6.1.

**Critères de mort — quel résultat me ferait conclure « non bénéfique ».**

| # | Si… | …alors |
|---|---|---|
| **K1** | je n'arrive pas à charger un channel en local (dialogue d'avertissement plein écran non contournable en mode `-p`, flag refusé, auth) | **aucune** preuve exécutée sur le contrat hôte → verdict `reporter`, jamais `adopter`. Les points 1-4 du protocole restent ouverts et nommés comme tels. |
| **K2** | `source` ne vaut **ni** la clé `.mcp.json` **ni** `serverInfo.name` | la correction §0 du 2026-08-14 est elle-même fausse : je la re-corrige et je l'écris noir sur blanc. |
| **K3** | une clé non-identifiant n'est **pas** droppée entièrement (tiret retiré, erreur bruyante, ou attribut conservé tel quel) | le garde-fou `assertIdentifierKeys()` est du YAGNI : cette branche du verdict meurt, et §1 + §2 sont à corriger. |
| **K4** | retirer `experimental.tools` casse le chargement **ou** rend `post_to_thread` non invocable | ce n'est pas du bruit inventé maison : on le garde, et §5 l. 130 est fausse. |
| **K5** | le nettoyage documentaire touche **plus de 10 fichiers** | l'effort n'est plus S : la fiche reste à M et le verdict bascule sur `reporter`. |
| **K6** | le seul bénéfice restant est documentaire **et** aucun utilisateur n'a signalé le quickstart cassé | filtre YAGNI : le verdict se limite au correctif de bug (« le quickstart ne marche pas »), pas à une « mise en conformité » vendue comme un chantier. |
| **K7** | `--dangerously-load-development-channels` a disparu ou est refusé par la 2.1.233 installée | la fiche s'effondre → `refuser`. |

### 6.3 Protocole de vérification

*Proposition de la veille, pas un résultat. On teste le vrai chemin de code, on ne théorise pas.*

> ⚠️ Non exécutable ici : l'allowlist Anthropic (`--channels` sans flag `dangerously`) et les managed settings `channelsEnabled` / `allowedChannelPlugins` (org Team/Enterprise, rôle Owner requis), ainsi que l'indisponibilité Bedrock / Google Cloud Agent Platform / Microsoft Foundry. Les cinq points ci-dessous restent tous exécutables sur le poste.

- [ ] Lancer une vraie session `claude --dangerously-load-development-channels server:<nom>` avec le `.mcp.json.sample` du quickstart tel quel, publier un événement MQTT, et constater si le channel se charge — cela tranche en une manipulation le désaccord `coordinator-channel` / `mcp-coordinator-channel` entre le sample et son README.
- [ ] Dans la même session, capturer le tag réellement injecté et comparer littéralement à `docs/operating-modes.md` l. 108 et au quickstart l. 109 : `source` ou `name` ? quelle valeur exacte pour `source` (nom du serveur `.mcp.json` ou `serverInfo.name` = `mcp-coordinator-channel`) ?
- [ ] Émettre volontairement une clé `meta` non-identifiant (ex. `target-modules`) et vérifier si c'est l'attribut entier qui disparaît (contrat officiel) ou le tiret qui est retiré (affirmation contredite entre chercheurs, §1). En déduire la forme exacte du garde-fou à ajouter dans `buildChannelNotification`.
- [ ] Retirer `capabilities.experimental.tools` du constructeur et relancer le smoke test : le channel se charge-t-il toujours et `post_to_thread` reste-t-il invocable ? Si oui, c'est du bruit inventé maison à supprimer.
- [ ] Vérifier si `claude --version` de l'environnement de dev satisfait la contrainte réelle, et retrouver d'où vient le « v2.1.80+ » de `README.md` l. 119 et `docs/usage.md` l. 156 — sinon retirer le numéro plutôt que de le laisser non sourcé.

### 6.4 Résultat observé

*Challenge du 2026-08-16. Claude Code **2.1.233**, Windows 11, dépôt à `mcp-coordinator@2.1.0`
(SDK MCP **v2.0.0**). PoC jetable dans le scratchpad, rien de commité hors cette fiche.*

> **Frontière exécuté / lu — à lire en premier.**
> **Exécuté :** toute la moitié serveur (poignée de main, capabilities, `tools/list`, émission des
> notifications), le parsing des flags CLI, et l'absence d'injection dans **tous** les modes
> headless disponibles.
> **Lu (preuve de premier niveau — code du client livré, `claude.exe` 2.1.233) :** le constructeur
> exact du tag, la regex de filtrage des clés `meta`, et les six portes de refus.
> **Jamais exécuté :** l'injection du tag dans une vraie session interactive. Un agent ne peut pas
> ouvrir le dialogue d'avertissement plein écran. **Aucune ligne de §7 ne repose sur cette partie.**

---

#### A. Le flag existe, il est parsé, et il est **totalement silencieux**

```
$ claude --help | grep -i channel
(aucune occurrence)                     ← conforme à la doc : « the flags work even though
                                          they aren't listed »

$ claude -p "OK" --dangerously-load-development-channels
error: option '--dangerously-load-development-channels <servers...>' argument missing

$ claude -p "OK" --dangerously-load-development-channels "plugin:nexistepas@nimportequoi"
Ready when you are — what would you like to work on?          ← aucune erreur, aucun avertissement

$ claude -p "OK" --channels "server:probe-key"
Ready when you are — what would you like to work on?          ← aucune erreur, aucun avertissement
```

Le flag est bien une option variadique déclarée. Mais **un channel refusé ne produit aucun message,
nulle part** : ni entrée inexistante, ni allowlist, ni policy.

> 🔴 **Corrigé après la passe adversariale — « il est parsé » était faux en mode `-p`.** Ce que
> l'essai « flag sans valeur » démontre, c'est que *commander* vérifie l'arité de l'option, **pas**
> que le parseur de channels tourne. Voir §K : en session non interactive, la valeur du flag
> `dangerously` n'est jamais lue. L'absence d'erreur sur `plugin:nexistepas@nimportequoi` s'explique
> donc par là, et non par un refus silencieux.
>
> Ce qui **reste vrai et mesuré** : `--channels server:probe-key`, lui, est bien parsé et enregistré
> même en `-p` (§K), et il n'a produit **ni tag ni message**. Le silence des portes est donc
> confirmé, mais sur ce test-là seulement.

#### B. Le contrat hôte, lu dans le binaire livré

`claude.exe` embarque le bundle. Extrait littéral du constructeur du tag (offset ≈ 298 811 000) :

```js
if (i.length > 0)
  w(`[channel] ${e}: dropped ${i.length} meta key(s) that don't match ${Bzf.source}: ` +
    `${i.map(([l]) => l).join(", ")}`, { level: "warn" });
let s = o.map(([l, c]) => ` ${l}="${Nl(c)}"`).join("");
let a = YTr(tEt, t);
return `<${tEt} source="${Nl(e)}"${s}>\n${a}\n</${tEt}>`;
```

et, quelques octets plus loin, la regex elle-même :

```js
Bzf = /^[a-zA-Z_][a-zA-Z0-9_]*$/
```

Ce que ça tranche, définitivement :

| Question de §6.3 | Réponse | Conséquence |
|---|---|---|
| `source` ou `name` ? | **`source`**, en dur dans le template | `examples/channels-quickstart/README.md` l. 109 (`<channel name=…>`) est **faux**. `docs/operating-modes.md` l. 108 a le bon attribut. |
| Clé `meta` non-identifiant ? | **l'attribut entier disparaît** — la clé est retirée de la liste avant construction | §1 et §2 ont raison, le « le tiret est retiré » est faux. **K3 est INMESURABLE, pas « non déclenché »** — voir §J : aucun attribut droppé n'a jamais été observé, seule une regex a été lue. |
| Le drop est-il silencieux ? | **Oui côté serveur.** Le `w(…, {level:"warn"})` part dans le journal de Claude Code ; le serveur MCP ne reçoit rien (pas d'ACK, par contrat). | Le garde-fou doit vivre **chez nous**, à l'émission. |
| Précision que la fiche n'a pas | La regex exige `[a-zA-Z_]` **en tête** : une clé commençant par un **chiffre** est droppée aussi. | `assertIdentifierKeys()` doit tester la regex complète, pas « pas de tiret ». |

#### C. `experimental.tools` : le scaffold officiel d'Anthropic ne le déclare pas

Le binaire embarque le générateur de squelette de channel d'Anthropic. Extrait littéral :

```js
const mcp = new Server(
  { name: '…', version: '0.1.0' },
  {
    capabilities: {
      tools: {},
      // Required: presence of this key registers the channel notification
      // listener on Claude's side.
      experimental: { 'claude/channel': {} },
    },
    instructions: "Events from … arrive as <channel source=\"…\" ...>. …",
  },
)
```

Trois preuves convergentes que `experimental.tools` est du bruit maison :
1. le scaffold officiel ne le déclare pas, et son commentaire dit que **seule** la présence de
   `claude/channel` enregistre l'écouteur ;
2. la porte `b3r(t)` du client ne teste que `claude/channel` ;
3. **exécuté :** ma sonde déclare `{experimental:{'claude/channel':{}}, tools:{}}` — **sans**
   `experimental.tools` — et son outil est bien exposé (`mcp__probe-key__probe_echo` dans
   l'événement `init`).

**K4 est INMESURABLE, pas « non déclenché ».** K4 a deux disjonctions — « casse le chargement »
**ou** « rend `post_to_thread` non invocable ». Seule la seconde a été testée. La première est
structurellement intestable ici, puisque le chargement n'a **jamais** réussi, y compris **avec**
`experimental.tools`. Voir §J.

#### D. Les six portes de refus — dont trois que la fiche ignore

Fonction `UWr` du binaire, transcrite (motifs littéraux) :

| # | Condition | Motif littéral |
|---|---|---|
| 1 | capability absente | `server did not declare claude/channel capability` |
| 2 | **`protocolEra === "modern"`** | `connection negotiated a modern protocol revision with no unsolicited notification path` |
| 3 | **provider ≠ `firstParty`** | `channels are not available on third-party providers` |
| 4 | **feature gate runtime** | `channels feature is not currently available` |
| 5 | policy org | `channels not enabled by org policy (set channelsEnabled: true in managed settings)` |
| 6 | entrée absente de la liste | `server <nom> not in --channels list for this session` |

Puis, pour une entrée sans `dev` : allowlist plugin ou serveur. `allowedChannelPlugins` **remplace**
la liste (`_5n` : `entries` d'org, sinon le registre embarqué) — la fiche avait raison.

**Les portes 2, 3 et 4 sont absentes de la fiche comme du dépôt.** La porte 4 en particulier est un
**interrupteur de déploiement progressif côté Anthropic** : la disponibilité du channel ne dépend
pas que de nous.

**Aucun de ces six motifs n'est jamais montré à l'utilisateur** (§A). Le mode d'échec nominal d'un
channel mal configuré est **le silence complet**.

#### E. La porte `era` **ne se déclenche pas** sur stdio — la migration SDK v2 ne casse pas le channel

C'était ma crainte n°1 en découvrant la porte 2, `main` venant de migrer sur
`@modelcontextprotocol/*@2.0.0`. Testé pour de vrai : proxy espion entre Claude Code et le **vrai**
`mcp-coordinator channel` recompilé sur le SDK v2.

```
C->S {"method":"initialize","params":{"protocolVersion":"2025-11-25",
      "clientInfo":{"name":"claude-code","version":"2.1.233",…}},"id":0}
S->C {"result":{"protocolVersion":"2025-11-25",
      "capabilities":{"experimental":{"claude/channel":{},"tools":{}},"tools":{}},
      "serverInfo":{"name":"mcp-coordinator-channel","version":"0.2.0"},
      "instructions":"You will receive coordination events…"},"id":0}
S!ERR [channel] MQTT error Connection refused: Not authorized
C->S {"method":"notifications/initialized"}
C->S {"method":"tools/list","id":1}
S->C {"result":{"tools":[{"name":"post_to_thread",…}]},"id":1}
```

**Aucun `server/discover` n'est envoyé.** La négociation d'ère (`rsb`, offset ≈ 290 157 000) repose
sur `server/discover` ; sur stdio Claude Code fait un `initialize` classique, donc l'ère retombe en
`legacy`. Contre-épreuve : ma sonde brute renvoyant `2025-06-18` (legacy sans ambiguïté) n'a pas
produit de tag non plus — la porte 2 n'explique donc pas l'absence d'injection.

Bénéfice secondaire : ce log **confirme par l'exécution** la divergence de §5 l. 134 — les
`instructions` disent `consultation_new (a.k.a. consultation_opened)` tandis que la description de
`post_to_thread` grave `event_type="consultation_opened"`, et le code émet `consultation_new`.

#### F. Aucun tag injecté, dans aucun mode headless

Quatre configurations, toutes avec `--dangerously-load-development-channels server:probe-key` :

| Mode | Tours | Notifications poussées | Tag `<channel>` |
|---|---|---|---|
| `-p` simple | 1 | 2 | **aucun** |
| `-p` + outil `Bash sleep 9` | 2 | 3 | **aucun** |
| `-p` + `sleep 9`, révision **legacy** `2025-06-18` | 2 | 3 | **aucun** |
| `--input-format/--output-format stream-json`, 3 messages | 3 | 9 | **aucun** |

Le serveur est pourtant vivant et vu comme connecté :

```
SYSTEM init  mcp_servers=[{"name":"probe-key","status":"connected"}]
             tools=[… 'mcp__probe-key__probe_echo' …]
ASSISTANT: TOUR_UN / TOUR_DEUX / TOUR_TROIS
occurrences PROBE_* dans le flux : AUCUNE
occurrences de '<channel' : 0
```

**Le test le plus dur :** l'événement `init` est **identique octet pour octet** avec et sans
`--dangerously-load-development-channels` — seuls `session_id` et `uuid` diffèrent. 23 clés
comparées, `cles seulement AVEC : []`.

Conclusion mesurée : **en mode headless, la surface channel n'est pas activée**, quelle que soit
l'ère annoncée.

> 🔴 **Corrigé — j'avais écrit ici que la cause « n'est pas observable ». C'était faux, et la passe
> adversariale l'a trouvée.** Voir §K : le flag `dangerously` est **mort par construction** en
> session non interactive. Ce n'est aucune des portes 3/4/6 : le court-circuit est en amont, dans le
> parseur d'arguments. Je déclarais inatteignable une réponse qui était dans le binaire que je
> venais de lire.

#### K. La cause, enfin nommée : le flag `dangerously` n'est pas lu hors session interactive

Parseur d'arguments, offset 309 396 560, extrait **littéral** :

```js
let Jr = Mt.channels,
    bt = Mt.dangerouslyLoadDevelopmentChannels,
    _t = [];
if (Jr && Jr.length > 0) _t = cn(Jr, "--channels"), cot(_t);
if (!gr) { if (bt && bt.length > 0) Or = cn(bt, "--dangerously-load-development-channels") }
```

`gr` est le drapeau *session non interactive*. Donc :

- `--channels` est parsé **et enregistré** (`cot` = `replaceAllowedChannels`) **quel que soit le
  mode**, y compris `-p` ;
- `--dangerously-load-development-channels` n'est parsé **que si `!gr`**, et son résultat `Or` ne
  sert ensuite qu'à `runOnboarding` — le chemin Ink **interactif**.

**Conséquence : les trois quarts de §F testaient un flag qui n'existe pas dans le mode où je le
passais.** Le résultat « aucun tag » était acquis d'avance, et l'égalité octet-pour-octet de l'`init`
en est la signature exacte : rien n'a été enregistré, donc rien ne pouvait différer.

Le seul essai réellement concluant est donc le troisième, `--channels server:probe-key` (§A) :
celui-là **a** été enregistré, et il a quand même été refusé — en silence. Le suspect principal est
la porte 4, dont la définition est, vérifiée telle quelle :

```js
function yJe() { return rt("tengu_harbor", !1) }
```

Un feature flag runtime **par défaut à `false`**. Sans preuve directe (rien n'est journalisé), c'est
une forte présomption, pas une certitude — les portes 2, 3 et 5 restent formellement possibles.

**Ce que ça change pour la fiche :** la condition de réveil de §7 n'est plus vague. Ce n'est pas
« quand ça sera testable », c'est **une session interactive conduite par un humain** — le seul
contexte où le flag est même lu.

**Confirmations obtenues au passage** (offsets vérifiés) : `tEt = "channel"` (le nom du tag est bien
une constante, offset 285 514 704) ; `b3r(e) { return !!e?.experimental?.["claude/channel"] }` — la
porte 1 ne teste **que** cette clé, jamais `experimental.tools` ; et `--channels server:X` produit
`{ kind: "server", name: "X" }`, comparé à la **clé d'enregistrement** du `.mcp.json`, ce qui
verrouille §G. Aucune normalisation tiret→underscore n'existe sur le chemin channel : les clés
rejetées par `Bzf` sont partitionnées et jamais réinjectées.

Dernier détail, intéressant pour nous : le commentaire du scaffold officiel d'Anthropic est **plus
laxiste que son propre code** — il dit « letters/digits/underscores », ce qui laisse croire qu'une
clé peut commencer par un chiffre, alors que `Bzf` l'interdit. Sur ce point précis, la fiche a raison
contre la documentation d'Anthropic.

#### G. Ce que ça dit du quickstart du dépôt

`examples/channels-quickstart/.mcp.json.sample` enregistre la clé **`coordinator-channel`** ; son
`README.md` l. 80-86 lance `server:mcp-coordinator-channel` en affirmant que l'argument
« matches the MCP server name in `.mcp.json` ». Cette phrase est **fausse de façon
autoréférentielle** : elle décrit un fichier livré dans le même dossier, qui dit autre chose.

> ⚠️ **Correction apportée après la passe adversariale — ma première rédaction surinterprétait.**
> Ce qui est prouvé, c'est la **contradiction documentaire**, par simple lecture des deux fichiers.
> Ce qui n'est **pas** prouvé, c'est que le bon nom réparerait quoi que ce soit : ma sonde de §F
> tournait sur `server:probe-key`, et `probe-key` **est** la clé d'enregistrement — l'événement
> `init` la rapporte comme `mcp_servers[].name` et l'outil est préfixé `mcp__probe-key__`. Autrement
> dit, **mon seul point de mesure en configuration nominale est lui aussi un échec** : nom correct,
> quatre modes, zéro tag. La porte 6 n'a donc jamais été exercée, ni en acceptation ni en rejet, et
> je ne peux pas exclure que les portes 3 ou 4 refusent de toute façon.
>
> Conclusion honnête : (a) est un **défaut de cohérence documentaire démontré**, pas un **bug
> fonctionnel diagnostiqué**. Corriger le README, oui. Écrire « le quickstart fonctionne
> maintenant », non — ce serait livrer un correctif invérifiable pour un mode d'échec que j'ai
> reproduit à l'identique dans la configuration prétendument correcte.

#### J. Adjudication des sept critères de mort

*Ajoutée après la passe adversariale. Ma première rédaction publiait le score des trois critères qui
ne se déclenchent pas et taisait ceux qui se déclenchent — c'est précisément ce que §6.2 devait
empêcher. Correction.*

| | Statut | Sur quoi |
|---|---|---|
| **K1** | 🔴 **DÉCLENCHÉ** | « je n'arrive pas à charger un channel en local » : quatre modes headless, 17 notifications poussées, `init` identique octet pour octet avec et sans le flag. Conséquent littéral : **`reporter`, jamais `adopter`**, points 1-4 de §6.3 laissés ouverts. |
| **K2** | ⚪ **inmesurable** | ne pouvait pas se déclencher : aucune valeur de `source` n'a jamais été observée. |
| **K3** | ⚪ **inmesurable** | aucun attribut droppé observé ; seule la regex a été **lue**. |
| **K4** | ⚪ **inmesurable** | disjonction « casse le chargement » intestable, le chargement n'ayant jamais réussi. |
| **K5** | 🟢 non déclenché | 6-7 fichiers < 10. Mesuré, valable. |
| **K6** | 🔴 **DÉCLENCHÉ** | bénéfice restant intégralement documentaire, **et** recherche exhaustive du tracker (`gh issue list --state all --search channel`) : `#130` (tracking, closed), `#277`, `#278` — **aucun utilisateur n'a signalé le quickstart**. Conséquent : le verdict se limite au correctif de bug. |
| **K7** | 🟢 non déclenché | le flag existe et est parsé (§A). |

**Trois des quatre « non-déclenchements » que j'avais annoncés étaient des faux négatifs d'un
instrument débranché.** Le seul critère réellement mesuré et réellement passé est K5.

#### H. Le « v2.1.80+ » n'est sourçable nulle part — 3 occurrences

```
$ git grep -n "2\.1\.80" -- .   (hors fiches de veille)
README.md:119:… a Channels-capable Claude Code (v2.1.80+). …
docs/operating-modes.md:11:| Claude Code version | Any | v2.1.80+ (research preview) |
docs/usage.md:158:… a Channels-capable Claude Code (v2.1.80+, launched with …
```

Aucune source du bundle ne mentionne v2.1.80 ; le seul numéro documenté est **v2.1.211**
(assainissement du relais). Constantes d'assainissement retrouvées telles quelles dans le binaire —
`BvS = 3500` code points, élision `⋯ N code points elided ⋯`, classes d'homoglyphes de guillemets et
de chevrons — et l'alphabet des identifiants de permission `abcdefghijkmnopqrstuvwxyz` : **25
lettres, pas de `l`**, exactement comme documenté.

#### I. Taille du nettoyage (critère K5)

`examples/channels-quickstart/README.md`, `README.md`, `docs/usage.md`, `docs/operating-modes.md`,
`cli/channel.ts`, `tests/unit/cli-channel.test.ts`, et optionnellement `cli/doctor.ts` : **6 à 7
fichiers**. Seuil K5 = 10. **K5 ne se déclenche pas.**

### 6.5 Contre-arguments

*Repris le 2026-08-16 après l'expérience. Les sept premiers sont ceux de la veille, réévalués ; les
quatre derniers sont apparus pendant le challenge.*

- ✅ **Tient et se durcit — le contre-argument le plus lourd, révélé par l'expérience : un refus de
  channel n'est notifié à personne.** Les six portes de `UWr` (§6.4-D) produisent chacune un motif
  textuel précis, et **aucun n'atteint jamais l'utilisateur ni le serveur MCP** (§6.4-A : entrée
  plugin inexistante, `--channels` sans allowlist → zéro message). Combiné au quickstart qui nomme
  un serveur inexistant (§6.4-G), le chemin d'onboarding échoue **en silence complet**. Aucune
  quantité de documentation ne compense ça : seul un check `doctor` côté nous peut parler.
- ✅ **Tient — la disponibilité ne dépend pas de nous.** Porte n°4 : `channels feature is not
  currently available`, un interrupteur de déploiement progressif côté Anthropic. On ne peut donc
  garantir à aucun utilisateur que la feature s'activera, même config parfaite, même version à jour.
- ✅ **Tient — fait brut : je n'ai pas réussi à activer un channel une seule fois** sur une
  installation stock et à jour (2.1.233), en quatre configurations (§6.4-F). La surface est
  documentée dans le `README.md` du projet et **indémontrable** sur le poste du mainteneur.
- ✂️ **Tombe partiellement — « on s'aligne sur une cible mouvante ».** Le *contrat protocolaire*
  s'est révélé bien plus stable et bien plus lisible que craint : le constructeur du tag et la regex
  des clés sont en clair dans le binaire livré, et concordent mot pour mot avec la doc publique
  (§6.4-B/H). Ce qui bouge n'est pas le contrat, c'est la **disponibilité**. L'argument reste donc
  valable, mais il faut le déplacer : ne pas graver la *syntaxe*, ce n'est pas le problème ; ne pas
  promettre la *feature*, si.

- **Le gain technique est mince.** Le vérificateur est explicite : `cli/channel.ts` est déjà conforme sur l'essentiel (capability, `instructions`, forme des `params`). Le travail réel se réduit à un garde-fou sur les clés `meta` et à un nettoyage de documentation. Vendre ça comme une mise en conformité de fond serait malhonnête.
- **On s'aligne sur une cible mouvante.** La doc prévient elle-même que la syntaxe de `--channels` et le contrat protocolaire peuvent changer. Chaque assertion de test et chaque ligne de doc gravant la syntaxe actuelle devra être révisée. Un contrat *research preview* n'est pas un contrat.
- ✅ **Confirmé par le code livré — le plafond de distribution ne se lève pas par du code.** Aucun refactor n'ouvre l'allowlist ; la seule voie documentée est relationnelle (contact partenaire Anthropic), et le formulaire public mène à un marketplace hors allowlist. Investir dans l'empaquetage plugin peut n'acheter strictement rien. *Vérifié en lisant `UWr`/`_5n` (§6.4-D) : `allowedChannelPlugins` **remplace** le registre embarqué, et le bypass `dev` est bien évalué **par entrée**.*
- ✅ **Confirmé, et le mécanisme est maintenant nommé — le verrou multi-cloud est définitif à notre échelle.** Une seule ligne du client le décide : `if (Yn() !== "firstParty") return { action: "skip", kind: "provider" }`. Auth Anthropic obligatoire, indisponible sur Bedrock, Google Cloud Agent Platform et Microsoft Foundry. Pour un projet dont l'argument est la coordination d'agents hétérogènes, faire du channel la surface de push principale, c'est amputer une partie de la cible sans recours.
- **Portabilité hors Claude Code.** `notifications/claude/channel` est un contrat propriétaire. La fiche A04 (`subscriptions/listen`) décrit la voie standard MCP ; renforcer l'investissement channel avant d'avoir tranché A04, c'est risquer d'entretenir deux chemins de push concurrents pour le même événement.
- ✅ **Le plus renforcé de tous — complexité pour l'auto-hébergeur.** L'expérience ajoute deux verrous invisibles que la fiche ne comptait pas : un **gate de disponibilité runtime** côté Anthropic, et surtout le fait que **chacun** de ces obstacles échoue sans le moindre message. Un flag nommé `dangerously`, un écran d'avertissement plein écran, un `.mcp.json` à éditer, un nom de serveur à faire correspondre à la lettre, et un master switch d'org invisible depuis la machine du développeur. Le chemin d'onboarding est déjà le plus fragile du projet — et il est aujourd'hui cassé dans l'exemple officiel (§5).
- ✅ **Renforcé — YAGNI sur le relais de permissions.** L'expérience ajoute une condition que la fiche ignorait : `Xzf` exige que le serveur déclare **les deux** capabilities *et* que `protocolEra !== "modern"`. C'est la partie séduisante, et c'est aussi celle qui exige un gating par identité d'expéditeur qu'un bus MQTT loopback anonyme ne sait pas fournir. Le `HANDOFF.md` l. 65 met déjà en garde contre une re-spike accidentelle « sans demande concrète d'un opérateur ». Aucune demande de ce type n'est arrivée.
- **Un channel mal filtré est un vecteur de prompt injection**, et la doc le dit explicitement. Ajouter des sources d'événements sans allowlist d'expéditeur transforme le bus de coordination en canal d'injection vers toutes les sessions abonnées.

---

## 7. Décision

| | |
|---|---|
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ✅ **reporter** · ⬜ refuser |
| **Date** | 2026-08-16 |
| **Justification** | **K1 s'est déclenché** : aucun channel n'a pu être chargé, et la cause est maintenant nommée — en session non interactive, `--dangerously-load-development-channels` **n'est jamais parsé** (§6.4-K). Aucune preuve exécutée du contrat hôte n'est donc atteignable depuis un agent. **K6 s'est déclenché aussi** : le bénéfice restant est intégralement documentaire, et le tracker ne contient aucune demande d'utilisateur. Le protocole interdit `adopter` sur la partie non exécutée. |
| **Issue / PR** | [#328](https://github.com/swoofer/mcp-coordinator/issues/328) — hygiène documentaire, **hors adoption** |
| **Jalon visé** | aucun. Réveil sur événement, pas sur version. |

### Ce qui est **reporté** (gelé par K1)

Les quatre points 1-4 de §6.3 restent **ouverts** : quel nom charge réellement le serveur, la valeur
exacte de `source`, le sort observé d'une clé `meta` non-identifiant, et l'innocuité du retrait de
`experimental.tools`. Le contrat est *connu* — lu dans le client livré, §6.4-B/C/D — mais **jamais
exercé**. La distinction est celle qui sépare une spécification d'un comportement.

Sont gelés avec eux les deux items de code que j'avais d'abord retenus :

- **`assertIdentifierKeys()`** — gelé par K1, et par ailleurs abattu par le filtre YAGNI : les six
  clés `meta` sont des **littéraux écrits en dur** dans `buildChannelNotification` (aucune clé
  calculée, aucune clé issue d'un payload MQTT), et elles sont déjà assertées par `toMatchObject`
  dans `tests/unit/cli-channel.test.ts`. Un garde-fou runtime ne pourrait se déclencher que si le
  mainteneur tape lui-même un tiret dans un littéral, dans un processus que personne ne peut
  activer. **Substitut sans risque et disponible tout de suite** : un test unitaire qui assert que
  les six clés émises matchent `/^[a-zA-Z_][a-zA-Z0-9_]*$/` — même protection, en CI, sans embarquer
  dans le runtime une regex lue dans un binaire de research preview.
- **Retrait de `experimental.tools`** — gelé par K1. Trois preuves convergentes disent que c'est du
  bruit (§6.4-C), mais aucune n'observe l'enregistrement du channel, et c'est le seul sous-système du
  projet dont le mode d'échec nominal est le silence total. À faire quand un tag aura été vu, pas
  avant.

**Condition de réveil — précise, et c'est le principal livrable de ce challenge.** Ce n'est pas
« quand ce sera testable » : c'est **la première session interactive, conduite par un humain devant
un terminal, où un tag `<channel>` est effectivement observé**. C'est le seul contexte où le flag est
même lu (§6.4-K). Ce jour-là, §6.3 se rejoue tel quel, en une manipulation.

### Ce qui est **écarté**

- **L'empaquetage en plugin sur marketplace** (la question de §6.1). Le code du client le confirme :
  `allowedChannelPlugins` **remplace** le registre embarqué, et rien dans un refactor n'ouvre
  l'allowlist Anthropic — la seule voie documentée est relationnelle. L'effort d'empaquetage peut
  n'acheter strictement rien.
- **Le relais de permissions (Phase 3).** YAGNI intact — `HANDOFF.md` l. 65 contient déjà, écrite par
  le mainteneur, la règle « don't accidentally re-spike this without a concrete operator request » ;
  aucune demande n'est arrivée. Et l'expérience ajoute une condition que la fiche ignorait : `Xzf`
  exige **les deux** capabilities *et* `protocolEra !== "modern"`.

### Ce qui est fait **hors verdict**, en hygiène de dépôt

Ces items ne dépendent d'aucun contrat hôte et **ne constituent pas une adoption de la feature**.
Ils existent parce que le dépôt affirme aujourd'hui des choses fausses à ses utilisateurs.

> ⚠️ **Ils forment un tout indissociable.** Corriger le nom de serveur **seul** serait *pire que ne
> rien faire* : aujourd'hui l'utilisateur abandonne en deux minutes parce que la doc est visiblement
> incohérente ; après un correctif cosmétique, la doc devient juste, il en conclut que le problème
> vient de sa machine, et la table de dépannage l'envoie explicitement debugger son daemon — pour
> une feature qu'aucune installation stock à jour n'arrive à charger. Le correctif de nom n'a de
> valeur que **soudé** à la démotion de statut.

1. **Démotion de statut** partout où le dépôt promet du push temps réel sans réserve : `README.md`
   l. 106-121, `docs/operating-modes.md`, `examples/channels-quickstart/`, et les **7 copies** de
   `start.modes` dans `docs/index.html` (1 inline + 6 dictionnaires de langue). Le statut réel à
   écrire : *ne se charge sur aucune installation stock à jour ; l'échec est totalement silencieux ;
   la disponibilité dépend d'un interrupteur côté Anthropic*.
2. **Le nom de serveur, aux deux endroits** — le quickstart **et** `README.md` l. 111-114, que §5
   croyait correcte et qui porte le même bug sur la page d'accueil.
3. **Les deux lignes de dépannage fausses** (`examples/channels-quickstart/README.md` l. 149-151) :
   Claude Code ne « refuse pas de démarrer », et l'absence de tags n'a rien à voir avec le daemon.
4. **Les 3 occurrences de « v2.1.80+ »**, non sourçables (`README.md` l. 119,
   `docs/operating-modes.md` l. 11, `docs/usage.md` l. 158). Le seul numéro documenté est v2.1.211.
5. **La chaîne `consultation_opened` de la description d'outil** (`cli/channel.ts` l. 240), qui
   contredit le code émettant `consultation_new` (l. 96). Ce n'est pas un renommage à trancher, c'est
   une chaîne fausse à effacer — deux lignes, plus les deux assertions de test qui la verrouillent
   (`tests/integration/channel-smoke.test.ts` l. 245, `tests/unit/cli-channel.test.ts` l. 339). Ne
   pas toucher aux trois fichiers de harnais qui utilisent `topic_kind`, champ différent.

**Effort réel : 8 à 10 fichiers**, et non les 6-7 que j'avais annoncés — l'écart vient entièrement de
`docs/index.html`, dont une seule chaîne coûte 7 éditions. Mon estimation initiale passait sous le
seuil K5 **précisément parce qu'elle laissait la page d'accueil mentir en six langues**. C'est le
pattern « garde-fou fantôme » de l'audit v0.13.0, appliqué à moi-même.

### Note de méthode

Mon verdict initial était `adopter partiellement`. Il a été renversé par la passe adversariale, sur
un point procédural que j'avais escamoté : §6.4 adjugeait K3, K4 et K5 — les trois critères
favorables — et restait muette sur K1, K2, K6 et K7. J'avais publié le score des critères qui
m'arrangeaient. Pire, j'avais introduit **après** le résultat décevant une troisième catégorie de
preuve (« lu dans le client livré ») absente du pré-enregistrement, et j'y avais fait transiter
exactement les quatre points que K1 déclarait gelés. C'est la définition de l'ajustement post-hoc,
et c'est précisément ce que §6.2 existe pour empêcher.

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. Fusion de 5 fiches brutes (`claude-code-channels-native`, `cc-native-channels-protocol`, `claude-channel-protocol-contract`, `claude-code-channels-contract`, `claude-channels-allowlist-gate`), toutes CONFIRMED. §5 vérifiée ligne à ligne contre le repo à `mcp-coordinator@2.0.1`. |
| 2026-08-14 | Vérification des faits : `--channels server:` non documenté, `source` = clé `.mcp.json`, 3e occurrence v2.1.80. |
| 2026-08-16 | **Challenge — verdict `reporter`.** K1 et K6 déclenchés. Cause trouvée et vérifiée dans le client livré : `--dangerously-load-development-channels` **n'est pas parsé hors session interactive**, donc le contrat hôte est inatteignable depuis un agent. Contrat hôte néanmoins **lu** dans `claude.exe` 2.1.233 : tag `<channel source="…">`, clés `meta` filtrées par `/^[a-zA-Z_][a-zA-Z0-9_]*$/` avec suppression de l'attribut entier, **six** portes de refus dont trois inconnues de la fiche, et un gate runtime `tengu_harbor` par défaut à `false`. Écarté : empaquetage plugin, relais de permissions. Corrections portées à la fiche : §0 (promesse de testabilité infirmée), §5 (`README.md` l. 114 n'est **pas** correcte — même bug qu'au quickstart ; `SECURITY.md` était un faux positif ; `docs/index.html` = 7 éditions par chaîne ; recalage des numéros de ligne sur `2.1.0`). Verdict initial `adopter partiellement` **renversé** par la passe adversariale. |
