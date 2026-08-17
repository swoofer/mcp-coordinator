# D01 — MENACE : cross-session messaging natif (`SendMessage` / `ListAgents`)

| Champ | Valeur |
|---|---|
| **ID** | `threat-cross-session-messaging` |
| **Surface** | claude-code |
| **Statut** | **GA conditionnel** — aucun label beta/preview dans la doc, mais l'activation dépend d'un feature flag distant (GrowthBook) et de la plateforme |
| **Disponible depuis** | `v2.1.224` (7 août 2026) · cross-machine `v2.1.225` (8 août) · `CLAUDE_CODE_MESSAGING_TOKEN` `v2.1.228+` · @-mention de session + ligne `/config` `v2.1.232` (13 août) |
| **Tier** | T1-incontournable |
| **Nature** | threat |
| **Effort estimé** | M |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — WSL 2 présent, Claude Code non installé ; feature flag distant |
| **Statut du challenge** | ✅ **tranché** (2026-08-16) — recadrage documentaire ; K3 déclenché, la frontière « portée » est morte |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- `docs/faq.md` : la fiche annonçait « 13 questions », le fichier en contient **12** (§5 corrigé).
- §2 : le marqueur `(à vérifier)` sur l'export des variables aux hooks est tranché par la doc — `code.claude.com/docs/en/cross-session-messaging` §« The session's inbox socket » dit explicitement que dans une session qui démarre avec le messaging actif, la variable est exportée **avant tout hook, y compris `SessionStart`** ; le trou n'existe que si la session démarre avant la récupération du feature flag. Le caveat du 3e vérificateur est donc réel mais plus étroit qu'écrit.
- §2 : deux affirmations secondaires marquées `(non vérifiable)` — voir ci-dessous.

**Faits confirmés à la source (aucune correction nécessaire) :** noms `SendMessage` / `ListAgents` avec `Permission required = No` pour les deux (tools-reference) ; input optionnel `summary`, « typically 5-10 words », tronqué au-delà de 200 caractères ; `/list-agents` alias `/peers` ; `/rename` et `--name` ; `@`-mention v2.1.232+ ; ligne `Peer address` préfixée `uds:` dans `/status` ; ligne `/config` « Messages from your other sessions » v2.1.232+ et rejet du shorthand `/config crossSessionInbound=value` ; `crossSessionInbound` = `accept|hold|refuse` ; `dialogExpiry` = `"60s"|"5m"|"10m"|"never"`, défaut `"5m"` ; `isolatePeerMachines: true` ; `sandbox.network.allowUnixSockets` / `allowAllUnixSockets` ; `permissions.deny: ["SendMessage","ListAgents"]` en nom nu ; trame `{"type":"auth","token":"…"}` en première ligne ; règles own-child (preuve par processus Linux/WSL 2, fallback token sur macOS post-mortem et conteneur PID 1) ; plafonds 50 (en attente de lecture) et 100 (en attente d'approbation, drop des plus anciens) ; rate-limit par expéditeur + drop des répétitions identiques ; pas de Windows natif, pas de Bedrock / Claude Platform on AWS / Google Cloud's Agent Platform / Microsoft Foundry ; kill switches `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`, `DO_NOT_TRACK`, `DISABLE_GROWTHBOOK` ; conteneurs (même conteneur OK, hôte ↔ conteneur bloqué). Aucun label beta/preview sur la page : le **statut « GA conditionnel » du tableau d'en-tête reste exact**. Tous les fichiers cités en §5 existent ; les numéros de ligne (`list_agents` 50, `wait_for_message` 53, `get_queued_messages` 80, `mqtt_publish` 96, README ligne 5) et les absences constatées (`hooks`/`settings.json`/`SessionStart` dans `cli/init.ts`, `process.platform` dans `cli/doctor.ts`) sont exacts.

**Marqueurs `(à vérifier)` restants :** aucun. Deux sous-affirmations sont passées en `(non vérifiable)` faute de source lisible : (a) « non settables via le bloc `env` » pour `CLAUDE_CODE_MESSAGING_SOCKET`/`_TOKEN`, (b) « 0 ou négatif = pas de deadline » pour `CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS` — la page `env-vars` est tronquée à la lecture et ne rend pas ces trois lignes. Le **nom** `CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS` est lui confirmé indirectement par la ligne `dialogExpiry` de `settings.md`.

**Testabilité :** ⚠️ partielle
Le poste dispose bien d'une WSL 2 (`Ubuntu`, version 2) mais **Claude Code n'y est pas installé** (`claude: command not found`) : l'installer suffit à débloquer les cinq premiers points du §6.3 (version, `/status`, `/peers`, export des variables en Bash, hook `SessionStart`, écriture socket depuis le daemon, rate-limit) plus le test d'arbitrage `ListAgents` vs `list_agents`. Reste hors de portée : l'activation elle-même dépend d'un feature flag distant GrowthBook qu'on ne contrôle pas (si le flag est off pour ce compte, `/list-agents` n'existe pas et rien n'est mesurable), ainsi que tout le volet cross-machine / cloud (Remote Control + seconde machine) et le fallback token macOS.

---

## 1. Ce que c'est

Depuis la v2.1.224, deux sessions Claude Code indépendantes se découvrent et s'écrivent sans serveur tiers. Chaque session bind une **socket UNIX d'inbox** par session, restreinte à l'utilisateur OS, et s'enregistre dans des fichiers sur disque — c'est ce registre disque qui sert de couche de découverte. Deux outils built-in en tirent parti : `ListAgents` (découverte, qui backe le slash `/list-agents`, alias `/peers`) et `SendMessage` (envoi de texte à une session par son nom). En local, le message ne passe que par la socket ; il ne transite par les serveurs Anthropic que pour joindre une autre machine (Remote Control) ou une session cloud. Rien à activer : « messaging is on with nothing to enable » quand les prérequis sont remplis.

Claude Code exporte le chemin de la socket dans `CLAUDE_CODE_MESSAGING_SOCKET` et un token par session dans `CLAUDE_CODE_MESSAGING_TOKEN` — **aux hooks et aux commandes Bash uniquement**, pas à un process serveur MCP. Un script peut poster dans sa propre session en envoyant `{"type":"auth","token":"<token>"}` en première ligne de connexion. Côté garanties, un message entrant n'est jamais traité comme un consentement de l'utilisateur, ne peut modifier ni CLAUDE.md ni les permissions, et les slash commands qu'il contient arrivent en texte inerte. Le transport est rate-limité par expéditeur, déduplique les répétitions identiques dans une courte fenêtre, et plafonne à 50 messages acceptés en attente de lecture et 100 messages tenus en attente d'approbation (les plus anciens sont jetés au-delà).

Les limites structurantes : **texte brut uniquement** (plus un champ `summary` optionnel de 5-10 mots), pas de fichiers ni d'historique de conversation transmis, **pas de Windows natif** (macOS et Linux, WSL 2 inclus), pas sur Amazon Bedrock / Claude Platform on AWS / Google Cloud's Agent Platform / Microsoft Foundry, et une découverte par fichiers disque qui empêche deux conteneurs distincts (ou hôte ↔ conteneur) de se voir. Tout est scopé à **un** compte OS/Anthropic.

## 2. Surface d'API exacte

```
Outils built-in (permission required = No pour les deux) :
  SendMessage            input optionnel `summary` (~5-10 mots, tronqué à 200 caractères)
  ListAgents

Slash / CLI :
  /list-agents           alias /peers
  /rename                --name            (nom adressable de la session)
  @<nom-de-session>      @-mention dans le prompt (v2.1.232+)
  /status                ligne "Peer address", chemin préfixé `uds:`
  /config                ligne "Messages from your other sessions" (v2.1.232+ ;
                         le shorthand `/config crossSessionInbound=value` est rejeté)

Settings :
  crossSessionInbound    "accept" | "hold" | "refuse"
  dialogExpiry           "60s" | "5m" | "10m" | "never"   (défaut "5m")
  isolatePeerMachines    bool
  sandbox.network.allowUnixSockets
  sandbox.network.allowAllUnixSockets
  permissions.deny: ["SendMessage", "ListAgents"]   (nom nu, sans spécificateur)

Env (exportées aux hooks et commandes Bash seulement ; « non settables via le bloc `env` »
     = (non vérifiable — page env-vars tronquée à la lecture)) :
  CLAUDE_CODE_MESSAGING_SOCKET          v2.1.224+
  CLAUDE_CODE_MESSAGING_TOKEN           v2.1.228+
  CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS    override de dialogExpiry (nom confirmé par settings.md) ;
                                        « 0 ou négatif = pas de deadline »
                                        (non vérifiable — page env-vars tronquée à la lecture)

Kill switches (coupent l'évaluation du feature flag, donc la feature) :
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC · DISABLE_TELEMETRY · DO_NOT_TRACK · DISABLE_GROWTHBOOK
```

Trame d'authentification, première ligne de la connexion à la socket :

```json
{"type":"auth","token":"<CLAUDE_CODE_MESSAGING_TOKEN>"}
```

Vérification « own-child » : Claude Code privilégie la **preuve par processus** (Linux/WSL 2) et ne retombe sur le token qu'à défaut — sur macOS une fois le process posteur terminé, et dans les conteneurs où Claude Code est PID 1. Sans trame token valide dans ces cas, une session même en `bypassPermissions` met le message en attente d'approbation : ce n'est pas un canal « fire and forget » fiable partout.

**Point de désaccord entre chercheurs, non tranché :** deux fiches brutes affirmaient que mcp-coordinator « peut écrire directement dans `CLAUDE_CODE_MESSAGING_SOCKET` avec le token » depuis le serveur MCP. Les vérificateurs ont classé cela comme **erreur matérielle** : la doc restreint l'export aux hooks et aux commandes Bash, et rien ne garantit qu'un process serveur MCP reçoive ces variables. Un troisième vérificateur ajoute qu'un hook `SessionStart` n'est lui non plus **pas garanti** de les voir — précision apportée par la vérification du 2026-08-14 : la doc dit qu'en session normale la variable est exportée **avant tout hook, `SessionStart` compris**, et que le trou n'existe que si la session démarre avant la récupération du feature flag (première session après install/upgrade), auquel cas hooks et process déjà lancés gardent la variable unset. Le seul chemin d'intégration documenté est donc *hook ou script Bash → socket* ; sa fiabilité réelle (fréquence du trou de flag) reste à mesurer empiriquement, cf. §6.3.

## 3. Sources

- https://code.claude.com/docs/en/cross-session-messaging
- https://code.claude.com/docs/en/tools-reference
- https://code.claude.com/docs/en/agents.md
- https://code.claude.com/docs/en/changelog
- https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md

## 4. Pourquoi ça concerne mcp-coordinator

**Risque si on ne fait rien :**

C'est le concurrent frontal du bus MQTT et du channel. La doc cite littéralement notre cas d'usage : coordonner des worktrees parallèles sur le même dépôt, une session prévenant les autres de ce qui a atterri. Pour un utilisateur macOS/Linux mono-poste qui voulait juste « faire passer une info d'une session à l'autre », `SendMessage` est gratuit, zero-install, sans daemon, sans broker, sans token JWT — et il rend le couple `register_agent` + `list_agents` + `wait_for_message` (`src/tools/agents-tools.ts`, `src/tools/mqtt-tools.ts`) redondant pour ce seul besoin. Il y a même une **collision de nommage directe** : notre outil MCP s'appelle `list_agents`, le built-in s'appelle `ListAgents`, et ils répondent à la même question en langage naturel — un modèle qui a les deux dans son contexte choisira le built-in, qui ne coûte ni permission ni round-trip réseau. Ne rien faire, c'est laisser le README vendre « messaging » alors que la plateforme le livre en dessous.

**Bénéfice attendu (ce qui reste défendable) :**

Les limites du natif dessinent exactement notre terrain, à condition de recentrer le discours dès maintenant : (a) **texte brut, aucune sémantique** — pas de schéma d'annonce, pas de `announce_work` avec impact scoring (`src/announce-workflow.ts`, `src/impact-scorer.ts`), pas de détection de conflit (`src/conflict-detector.ts`), pas de carte de dépendances (`src/dependency-map.ts`), pas de registre de fichiers en cours (`src/working-files-tracker.ts`) ; (b) **pas d'audit interrogeable** — le message reste bien dans le transcript du destinataire, mais il n'existe aucune API d'historique, aucune trace signée, rien qui alimente `src/observability/` ou le dashboard ; (c) **mono-utilisateur, mono-compte** — pas de multi-org, pas de tenants, ce que fait `src/auth/` ; (d) **pas de Windows natif, pas de Bedrock/AWS/GCP/Foundry, pas d'inter-conteneurs** ; (e) **cross-vendor** — le natif ne parle qu'à Claude Code, alors que le README revendique Cursor / Cline / Aider.

Il reste une opportunité d'intégration, mais plus étroite que ce que les fiches brutes annonçaient : un **hook** installé par `mcp-coordinator init` peut lire `CLAUDE_CODE_MESSAGING_SOCKET` / `CLAUDE_CODE_MESSAGING_TOKEN`, les enregistrer dans l'agent-registry, et permettre au coordinateur de pousser une alerte de conflit dans une session cible sans passer par MQTT ni par le channel. Attention : le rate-limit et le dedup du transport **étoufferaient activement** un flux d'alertes de conflit répétitives — ce n'est pas un canal de télémétrie.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/tools/agents-tools.ts` | Contient `register_agent`, `list_agents`, `heartbeat`, `agent_activity`. `list_agents` (ligne 50) entre en collision sémantique directe avec le built-in `ListAgents`. Question : le renommer/redécrire pour marquer la différence (registre persistant multi-org vs pairs locaux), ou l'assumer. |
| `src/tools/mqtt-tools.ts` | `wait_for_message` (ligne 53), `get_queued_messages` (ligne 80), `mqtt_publish` (ligne 96). C'est la partie « transport de messages » que le natif concurrence le plus frontalement en mono-poste. |
| `src/mqtt-broker.ts`, `src/mqtt-bridge.ts` | ~34 Ko de broker embarqué + bridge. Si le seul usage réel est « prévenir l'autre session », le natif rend cette masse difficile à justifier pour un utilisateur solo. À conserver pour le multi-machine, le multi-org et le cross-vendor. |
| `cli/channel.ts` | Serveur MCP stdio des Claude Code Channels (push `notifications/claude/channel` + `post_to_thread`). Chevauchement partiel : les deux poussent du texte dans une session. Le channel garde l'avantage du payload structuré et du thread de consultation. |
| `src/agent-registry.ts` | Point d'atterrissage naturel d'un `messaging_socket` / `peer_name` par agent, si le chemin hook → socket est validé. |
| `src/conflict-detector.ts` | Producteur des alertes qu'on voudrait pousser dans une session. Attention au dedup/rate-limit du transport natif. |
| `src/sse-emitter.ts` | Second canal de push existant (SSE vers dashboard). À ne pas dupliquer une troisième fois. |
| `cli/init.ts` | Aucune génération de hooks aujourd'hui (aucune occurrence de `hooks` / `settings.json` / `SessionStart`). Ce serait le point d'installation d'un hook de capture des variables `CLAUDE_CODE_MESSAGING_*`. |
| `cli/doctor.ts` | Aucun check de plateforme aujourd'hui (aucune occurrence de `process.platform`). Candidat pour un check « cross-session messaging natif disponible ici ? » afin d'expliquer à l'utilisateur ce qui se recouvre. |
| `README.md` | Ligne 5 : « Stop your AI coding agents from overwriting each other's work » — le positionnement reste valide, mais l'argumentaire différenciant face au natif doit y figurer explicitement. |
| `docs/faq.md` | 12 questions, aucune sur la concurrence. Une entrée « Claude Code sait déjà envoyer des messages entre sessions, pourquoi mcp-coordinator ? » manque. |
| `docs/index.html` | Landing page (443 Ko, 6 langues inline) : tout claim de type « messaging » y est à réviser en même temps que le README. |
| `sdk/src/client.ts` | Le SDK client TS n'est pas concerné techniquement, mais il matérialise l'argument cross-vendor que le natif ne couvre pas. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Faut-il traiter le cross-session messaging natif comme un **transport à absorber** — un hook installé par `init` capture `CLAUDE_CODE_MESSAGING_SOCKET` et le coordinateur y pousse ses alertes de conflit, MQTT devenant optionnel en mono-poste — ou comme un **concurrent à ignorer**, en assumant que MQTT reste le seul bus et en reportant tout l'effort sur la différenciation sémantique (schéma d'annonce, audit, multi-org, cross-vendor) dans README / faq / landing ?

### 6.2 Hypothèse

*Pré-enregistrée le 2026-08-16, **avant** toute exécution. Challenge groupé avec `D02`, verdict par fiche.*

**Ce que les challenges précédents ont déjà établi et que je réutilise :**

- `C12` : `ListAgents` n'apparaît qu'avec `CLAUDE_CODE_HARBOR_KITE=1` — mesuré, 35 → 36 outils sur
  Windows natif. **La porte s'ouvre donc, et je peux reproduire le natif pour de vrai** au lieu de
  comparer sur catalogue.
- `C13` : `SendMessage` est **un seul outil à deux espaces d'adressage** ; son `validateInput` rejette
  les schémas `uds:` / `bridge:` quand la porte est fermée, avec le message
  « Cross-session messaging is not available in this session. »

**Ce que je crois qu'il va se passer.**

1. Le natif est **par machine et par utilisateur** : sockets locales, aucune notion d'org, aucune
   authentification d'expéditeur. La frontière factuelle sera donc une frontière de **portée et de
   preuve**, pas de fonctionnalité.
2. `CLAUDE_CODE_MESSAGING_SOCKET` existera et sera un chemin local.
3. Le natif n'a **aucune trace persistante** : pas d'audit, pas d'historique interrogeable.

**Verdict pressenti :** réponse = **recadrage documentaire**, pas contre-mesure technique. Ni
absorption (le hook ajoute une dépendance à une surface derrière un flag distant), ni déni.

**Critères de mort.**

| # | Si… | …alors |
|---|---|---|
| **K1** | je n'arrive pas à ouvrir la porte et à observer le natif | pas de frontière factuelle → je le dis, et la fiche reste sur de la doc. |
| **K2** | le natif porte une **identité d'expéditeur vérifiable** | notre argument « audit » s'effondre en grande partie : à écrire noir sur blanc. |
| **K3** | le natif franchit la machine (socket réseau, pas locale) | la frontière de portée tombe, et c'est le pire cas pour le projet. |
| **K4** | le natif persiste les messages de façon interrogeable | l'argument « historique + chaîne d'audit » tombe. |
| **K5** | absorber le natif par hook coûte plus de **8 fichiers** | la branche « transport à absorber » est disqualifiée par le coût. |
| **K6** | aucun utilisateur n'a demandé de coordination inter-sessions locale | filtre YAGNI sur la branche absorption. |

### 6.3 Protocole de vérification

<Comment on tranche : PoC, lecture de code, mesure, test avec un vrai client MCP, benchmark de tokens…
Le principe maison : on teste le vrai chemin de code, on ne théorise pas.>

> ⚠️ Claude Code n'est pas installé dans la WSL 2 du poste (à installer avant tout PoC) ; et même installé, l'activation dépend d'un feature flag GrowthBook non contrôlable — le volet cross-machine / cloud (Remote Control, seconde machine) et le fallback token macOS restent hors de portée ici.

- [ ] Sur WSL 2 (Windows natif exclu par la feature), vérifier avec `claude --version` que le binaire est ≥ v2.1.228, puis `/status` pour confirmer la présence de la ligne `Peer address` préfixée `uds:` et `/peers` pour la découverte.
- [ ] Dans une session, exécuter une commande Bash triviale qui affiche `CLAUDE_CODE_MESSAGING_SOCKET` et `CLAUDE_CODE_MESSAGING_TOKEN` : confirmer qu'elles sont réellement exportées, et à quel moment (avant/après le fetch du feature flag).
- [ ] Écrire un hook minimal (`SessionStart`) qui écrit ces deux variables dans un fichier, et mesurer sur 5 démarrages combien de fois elles sont vides — c'est le caveat n°4 des vérificateurs.
- [ ] Depuis le daemon mcp-coordinator (process serveur MCP, pas hook), tenter d'ouvrir la socket avec la trame `{"type":"auth","token":"…"}` : confirmer ou infirmer l'erreur matérielle signalée par deux vérificateurs.
- [ ] Émettre 10 alertes de conflit similaires en 60 s via la socket et compter combien arrivent : mesurer l'effet réel du rate-limit et du dedup sur un flux de coordination.
- [ ] Lancer une session avec `mcp-coordinator` monté et observer, sur un prompt du type « qui travaille sur quoi ? », si le modèle appelle `ListAgents` (built-in) ou `list_agents` (le nôtre).

### 6.4 Résultat observé

*Challenge du 2026-08-16, groupé avec `D02`. Claude Code **2.1.233**, Windows 11 natif.*

> **Frontière exécuté / lu.** **Exécuté :** l'ouverture de la porte, la découverte de pairs entre deux
> sessions concurrentes, une tentative d'envoi. **Lu (client livré) :** le mécanisme de découverte,
> le schéma de provenance, les transports. **Une limite de débit** a interrompu la première tentative
> d'expérience ; elle a été reprise et menée à terme.

#### A. 🔴 §1 est fausse sur Windows : la feature n'est pas absente, elle est derrière un flag

§1 affirme « **pas de Windows natif** (macOS et Linux, WSL 2 inclus) ». Mesuré sur Windows 11 natif,
Claude Code 2.1.233 :

```
$ CLAUDE_CODE_HARBOR_KITE=1 claude -p "Appelle ListAgents…" --allowedTools ListAgents
```
```
No reachable agents.
```

**`ListAgents` s'exécute et répond normalement** — « aucun pair joignable » est une réponse
fonctionnelle, pas une erreur d'indisponibilité. Combiné à la mesure de `C12` (35 → 36 outils dès que
`CLAUDE_CODE_HARBOR_KITE=1` est posé), le fait est établi :

> **Le cross-session messaging n'est pas absent de Windows natif : il y est désactivé par défaut,
> derrière un feature flag distant, et une variable d'environnement l'active.**

C'est la même correction que `C12` a portée sur sa propre matrice — et elle a la même conséquence
stratégique : **une frontière produit fondée sur « le natif ne marche pas sur Windows » repose sur un
interrupteur qu'Anthropic peut basculer sans livrer de release.**

Précision apportée par la lecture du client : Windows natif a son **propre** flag,
`tengu_harbor_kite_win`, distinct de `tengu_harbor_kite`. Ce ne sont donc pas « macOS/Linux ✓ ·
Windows ✗ » mais **deux interrupteurs**, tous deux à `false` par défaut.

#### B. Ce que `ListAgents` montre — et ne montre pas

Deux sessions concurrentes, porte ouverte :

```
Peer sessions (1):
  d01-9e [4b510d]  ·  interactive  ·  started 25s ago
```

Nom dérivé du répertoire, identifiant court, type, âge. **Aucune org, aucune identité de compte,
aucune information d'authentification.** Le record sous-jacent porte davantage (`sessionId`, `pid`,
`entrypoint`), mais rien qui relève de l'organisation.

#### C. 🔴 RETIRÉ — ce que j'ai pris pour un défaut du natif était un artefact de mon protocole

J'avais mesuré qu'une session de listage voyait un pair, et qu'une session émettrice lancée 18 s plus
tard n'en voyait aucun. J'allais l'écrire comme une « découverte incohérente ». **C'est faux.**

La découverte n'est pas la lecture d'un registre : c'est un `connect()` **réel** sur la socket de
chaque pair, réévalué à chaque appel, avec un timeout de 250 ms ; une fiche dont le process est prouvé
mort est supprimée. Mes deux `claude -p` **ne coexistaient pas** — le premier avait fini son tour et
fermé sa socket. Le natif a fait exactement ce qu'il devait faire.

**Le seul protocole valide serait deux sessions interactives concurrentes maintenues vivantes.**
Publier ce point comme un défaut aurait été réfutable en une capture d'écran.

#### D. K2 — l'identité existe, mais elle n'est **pas** opposable, et Anthropic l'écrit

Mon critère K2 demandait s'il existe une identité d'expéditeur vérifiable. Réponse nuancée, et elle
oblige à **reformuler entièrement l'argument « audit »** de §4 :

- `from` et `name` sont **auto-déclarés**. Le schéma du client le dit littéralement : *« sender-authored
  and kept only for reply routing, so it is **forgeable by any same-user process** »*.
- Il existe **une** identité noyau, `verifiedPeerPid`, lue via `SO_PEERCRED` / `LOCAL_PEERPID` — jamais
  depuis la charge utile. Mais elle est **absente sur Windows**, elle identifie le **process
  connecteur** (donc le relais, pas l'auteur, en trafic relayé), et Anthropic la qualifie elle-même de
  *« provenance, not an authentication token »*.
- Le token de session prouve *« un process capable de lire `~/.claude` »* — c'est-à-dire **le même
  utilisateur OS**, pas quelle session.

**K2 ne se déclenche pas**, mais la formulation de la fiche (« le natif n'a aucune identité ») est
fausse et se ferait démonter. La formulation juste, et citable : **l'identité affichée est
auto-déclarée et forgeable par tout process du même utilisateur ; la seule identité noyau est un
identifiant de process de connexion, absent sur Windows, qu'Anthropic présente comme de la provenance
et non de l'authentification.**

#### E. 🔴 K3 SE DÉCLENCHE — le natif **franchit la machine**, et c'est le pire cas

Mon critère K3 disait : « si le natif franchit la machine, la frontière de portée tombe, et c'est le
pire cas pour le projet ». Il se déclenche.

`listAllPeers` agrège **quatre** transports, vérifiés : `uds`, `cloud`, `bridge`, `did`. Et un réglage
existe **précisément** pour restreindre ce que je croyais impossible :

> `isolatePeerMachines` — « Require explicit approval before SendMessage can reach a peer session **on
> another machine** via Remote Control »

Un réglage n'existe que pour restreindre un comportement qui existe. S'y ajoutent
`remoteControlAtStartup` et `autoUploadSessions`.

**La frontière « portée / multi-machine » est morte.** Et le second volet est plus dur encore : notre
produit **n'exerce pas** la frontière qu'il prétend défendre — `docs/mqtt-topics.md` l. 23 dit que
« the coordinator publishes EVERYTHING under a hardcoded org `default` », et `C13` a mesuré que zéro
agent n'a jamais été enregistré. Je défendais une frontière théorique que le natif vient de franchir,
avec un produit qui ne s'en sert pas.

#### F. Ce qui reste réellement défendable

Après mesure, deux frontières seulement tiennent debout :

1. **Cross-vendor.** Cursor, Cline, Aider. Anthropic ne peut structurellement pas les couvrir.
2. **Cross-humain.** Deux comptes Anthropic distincts. Le natif est scopé à **un** compte.

Et une troisième, de nature différente : **la durabilité**. Le natif est derrière des flags distants —
`tengu_harbor_kite` et `tengu_harbor_kite_win` en opt-in (défaut `false`), ce qui signifie qu'Anthropic
peut l'**allumer** partout sans livrer de release.

#### G. K6 — zéro demande, et le seul signal va dans l'autre sens

Recherche des issues sur `messaging`, `peer`, `orchestration`, `multi-machine`, `cross-session` :
**une seule** — **#279**, qui se plaint du **scoping trop large** de la couche pairs existante et
demande de le **réduire**. Le seul retour utilisateur sur ce terrain demande moins de portée, pas
plus.

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **Le chemin d'intégration principal est peut-être fermé.** Deux vérificateurs indépendants qualifient d'erreur matérielle l'idée que le serveur MCP puisse écrire dans la socket : l'export est documenté pour les hooks et les commandes Bash. Un troisième ajoute que même un hook `SessionStart` peut ne rien voir si le feature flag n'est pas encore résolu. Bâtir dessus avant le PoC serait le pattern « garde-fou fantôme » déjà relevé dans l'audit v0.13.0.
- **Le mainteneur ne peut pas dogfooder.** Windows natif, PowerShell : la feature n'existe pas sur la machine de dev principale. Toute intégration serait développée et maintenue à l'aveugle, testée uniquement sous WSL 2 ou en CI Linux — coût de maintenance réel pour une capacité invérifiable au quotidien.
- **L'argument « pas de Windows » est plus faible qu'il n'y paraît.** Linux inclut explicitement WSL 2 : un développeur Windows sous WSL 2 **est** couvert par le natif. La faille de plateforme sur laquelle on comptait pour se différencier ne protège qu'une fraction du public.
- **Dépendance à un feature flag distant.** L'activation passe par GrowthBook et se coupe avec `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`, `DO_NOT_TRACK` ou `DISABLE_GROWTHBOOK` — soit exactement les variables qu'un auto-hébergeur soucieux de confidentialité met en premier. Notre public cible est probablement celui pour qui la feature est éteinte.
- **Le transport est hostile à notre charge.** Rate-limit par expéditeur et drop des répétitions identiques : un flux d'alertes de conflit, par nature répétitif, serait activement étouffé. Le natif est conçu pour de la conversation humaine occasionnelle, pas pour de la coordination machine.
- **Un troisième canal de push.** Nous avons déjà SSE (`src/sse-emitter.ts`) et le channel MCP (`cli/channel.ts`), ce dernier encore en research preview. Ajouter la socket ferait trois chemins pour « prévenir une session », chacun avec ses modes de panne. YAGNI tant que le channel n'est pas stabilisé.
- **Casse la portabilité.** Toute logique adossée à la socket ne fonctionne que sous Claude Code — le README revendique Cursor, Cline et Aider. C'est du code qui ne sert qu'un seul client et affaiblit précisément l'argument cross-vendor qu'on veut mettre en avant.
- **Un chercheur surestimait le manque de persistance.** « Aucune persistance, aucun historique » est une inférence, pas un fait documenté : un message reçu apparaît dans la conversation sous le nom de la session émettrice et y reste. Ce qui manque réellement est une **API d'historique interrogeable** — l'argument de différenciation doit être formulé ainsi, sinon il est réfutable en une capture d'écran.
- **De même pour les conteneurs.** « Pas d'inter-conteneurs » est trop absolu : deux sessions dans le **même** conteneur se messagent très bien, y compris sur self-hosted runner. Seuls hôte ↔ conteneur et conteneurs distincts sont bloqués.

---

## 7. Décision

| | |
|---|---|
| **Verdict** | **Réponse : recadrage documentaire** — ni absorption du natif, ni déni. ⬜ contre-mesure technique · ✅ **recadrage** · ⬜ recouvrement assumé |
| **Date** | 2026-08-16 |
| **Justification** | **K3 s'est déclenché** : le natif **franchit la machine** (quatre transports — `uds`, `cloud`, `bridge`, `did` — et un réglage `isolatePeerMachines` qui existe précisément pour restreindre l'accès à « a peer session on another machine »). Ma frontière principale — la portée — est donc **morte**, et notre produit ne l'exerçait même pas (org codée en dur à `default`). K6 s'est déclenché aussi, et le seul retour utilisateur, #279, demande de **réduire** la portée de la couche pairs. Il ne reste que deux frontières mesurées : **cross-vendor** et **cross-humain**. |
| **Issue / PR** | aucune |
| **Jalon visé** | réécriture de §1 et §4 avant toute réutilisation |

### La frontière factuelle — c'est le livrable de cette fiche

**Ce que le natif fait**, mesuré : découverte de pairs par sonde de connexion réelle (timeout 250 ms,
réévaluée à chaque appel), messagerie texte entre sessions, **y compris sur Windows natif** et
**y compris entre machines** via Remote Control.

**Ce que le natif ne fait pas** : aucune identité d'expéditeur opposable (`from` est auto-déclaré et
« forgeable by any same-user process » — leur schéma) ; aucune notion d'organisation ; aucune API
d'historique interrogeable ; un seul compte Anthropic.

**Ce qui reste défendable** — et rien d'autre : **cross-vendor** (Cursor, Cline, Aider, que le natif
ne peut structurellement pas couvrir), **cross-humain** (deux comptes distincts), et **la chaîne
d'audit**, à condition de la formuler correctement (§6.4-D).

### Ce qui est refusé

**La branche « transport à absorber »** de §6.1 — un hook qui capterait `CLAUDE_CODE_MESSAGING_SOCKET`
pour y pousser nos alertes. Elle ajouterait une dépendance à une surface gouvernée par **deux flags
distants** que nous ne contrôlons pas, pour un besoin que personne n'a exprimé (K6).

### Corrections obligatoires avant réutilisation

- **§1 est fausse deux fois** : « pas de Windows natif » (c'est un flag dédié, `tengu_harbor_kite_win`,
  pas une absence) et l'implicite « mono-machine » (le natif franchit la machine).
- **§4 doit reformuler l'argument d'audit.** « Le natif n'a aucune identité » est faux et se ferait
  démonter ; la formulation juste est celle de §6.4-D, et elle a l'avantage d'être une citation de
  leur propre schéma.
- **Retirer la frontière « portée »** de tout argumentaire produit.

### Note de méthode — j'ai failli publier un artefact de mon protocole comme un défaut du natif

J'avais mesuré qu'une session émettrice ne voyait aucun pair 18 s après qu'une autre en ait vu un, et
j'allais l'écrire comme une « découverte incohérente ». La découverte est en réalité une **sonde de
connexion live** : mes deux `claude -p` ne coexistaient pas, le premier avait fermé sa socket. **Le
natif s'est comporté correctement ; c'est mon protocole qui était faux.**

C'est la troisième fois de ce corpus que je conclus trop vite depuis un montage incomplet — après le
collecteur OTLP manquant de `C11` et l'absence locale de `roster.json` en `C13`. Le point commun :
**je n'avais pas vérifié que mon instrument mesurait ce que je croyais.**

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme (fusion de 4 fiches brutes, verdicts CONFIRMED). |
| 2026-08-14 | Vérification des faits : API et statut confirmés, faq 13→12 questions, 2 points non vérifiables, testabilité partielle. |
| 2026-08-16 | **Challenge (groupé avec `D02`) — réponse : recadrage documentaire.** **K3 déclenché, c'est le pire cas** : le natif **franchit la machine** — quatre transports (`uds`, `cloud`, `bridge`, `did`) et un réglage `isolatePeerMachines` qui existe précisément pour restreindre « a peer session on another machine via Remote Control ». La frontière « portée » est **morte**, et notre produit ne l'exerçait pas (org codée en dur à `default`). **§1 est fausse deux fois** : Windows natif est couvert derrière son propre flag `tengu_harbor_kite_win` (mesuré : `ListAgents` voit un pair avec `CLAUDE_CODE_HARBOR_KITE=1`), et le natif n'est pas mono-machine. **K2 non déclenché mais l'argument audit est à reformuler** : `from` est auto-déclaré et « forgeable by any same-user process » (leur schéma), la seule identité noyau `verifiedPeerPid` est absente sur Windows et qualifiée par Anthropic de « provenance, not an authentication token ». **J'ai retiré un résultat** : ma « découverte incohérente » était un artefact de protocole — la découverte est une sonde de connexion live à 250 ms, et mes deux `claude -p` ne coexistaient pas. Frontières survivantes, mesurées : **cross-vendor** et **cross-humain**. K6 déclenché ; le seul retour utilisateur (#279) demande de **réduire** la portée. |
