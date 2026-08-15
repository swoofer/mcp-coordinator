# Synthèse — veille plateforme Claude pour mcp-coordinator

> **Date de la veille :** 2026-08-14
> **Méthode :** 8 chercheurs en parallèle sur 8 surfaces distinctes (Claude Code, spec MCP, MCP auth/registre,
> Agent SDK, primitives agentiques de l'API, Managed Agents, balayage chronologique jan→août 2026, écosystème),
> puis vérification adversariale de chaque fiche par un agent chargé de la **réfuter**, puis passe de complétude.
> **Volume :** 161 fiches brutes → 66 vérifications (59 CONFIRMED, 6 PLAUSIBLE, 1 REFUTED) → **56 dossiers de décision**.
>
> **Ce document est une lecture stratégique, pas un compte rendu de tests.** Chaque affirmation renvoie à une
> fiche qui porte ses sources. Rien ici n'a encore été vérifié contre le comportement réel du daemon — c'est
> précisément l'objet des sessions de challenge.

---

## 1. Ce qui a changé pendant qu'on regardait ailleurs

Trois mouvements se sont produits ces six derniers mois, et ils ne tirent pas dans le même sens.

**Le protocole MCP a changé de forme.** La révision `2026-07-28` — publiée il y a dix-sept jours — supprime
`initialize`, supprime `Mcp-Session-Id`, déprécie le transport HTTP+SSE, supprime la resumabilité SSE
(`Last-Event-ID`), rend `server/discover` obligatoire côté serveur, et déprécie `roots`, `sampling` et
`logging` au profit d'un mécanisme unique de multi-aller-retour (MRTR). En parallèle, le SDK TypeScript est
passé en v2 le 27 juillet, éclaté en `@modelcontextprotocol/{core,client,server,node,express,hono,fastify}` —
alors que le projet est épinglé sur `@modelcontextprotocol/sdk ^1.29`, un paquet qui n'existe plus sous ce nom
dans la nouvelle ligne. → [A01](A01-mcp-2026-07-28-stateless.md), [A02](A02-mcp-sdk-typescript-v2.md)

**Anthropic a livré la moitié du produit.** Cross-session messaging (`SendMessage` / `ListAgents`) est GA
depuis la v2.1.224 du 7 août. Agent Teams apporte une task list partagée, une mailbox entre teammates et du
file locking. Les worktrees sont natifs (`--worktree`, `EnterWorktree`). `claude agents` affiche un tableau de
bord des sessions dans le terminal. Chacune de ces briques recouvre quelque chose que mcp-coordinator fait.
→ [D01](D01-threat-cross-session-messaging.md), [D02](D02-threat-agent-teams.md),
[D03](D03-threat-native-worktrees.md), [D05](D05-threat-agent-view.md)

**Et Anthropic documente noir sur blanc l'autre moitié, celle qu'il ne livre pas.** La page Agent Teams écrit
littéralement : *« Agent teams don't isolate teammates in worktrees, so partition the work »* et *« Two
teammates editing the same file leads to overwrites »*. Le conflit de fichier n'est pas un oubli : c'est un
non-objectif assumé. C'est exactement le trou que le projet remplit.

---

## 2. Les trois mouvements stratégiques

### Mouvement 1 — Passer de l'observation à la contrainte

C'est le constat le plus important de cette veille, et il ne concerne pas une feature mais quatre surfaces qui
convergent vers la même bascule.

Aujourd'hui, la promesse du README est « les conflits sont détectés **avant** qu'une ligne de code soit
écrite ». La réalité de l'implémentation est que l'agent doit **vouloir** appeler `announce`. Rien ne l'y
oblige. Un modèle distrait, un contexte compacté, un tool search qui n'a pas remonté l'outil : et la garantie
tombe en silence.

Quatre mécanismes rendent la contrainte structurelle :

| Surface | Mécanisme | Ce qu'il permet |
|---|---|---|
| Claude Code | `hooks[].type: "mcp_tool"` sur `PreToolUse` | Appeler un outil du coordinateur **avant** chaque `Edit`/`Write`, et renvoyer `permissionDecision: "deny"` — sans que l'agent ait à coopérer → [C01](C01-hook-mcp-tool-gate.md) |
| Agent SDK | `canUseTool` + réponse hors bande par `requestId` | Suspendre l'écriture, interroger le daemon, répondre quand le pair a libéré le fichier — sans bloquer la boucle → [F02](F02-canusetool-distributed-lock.md) |
| Protocole MCP | `InputRequiredResult` / `resultType: "input_required"` | Un `announce` qui détecte un conflit ne renvoie plus un texte que le modèle peut ignorer : il renvoie une demande à laquelle la boucle d'agent **doit** répondre → [A03](A03-mrtr-input-required.md) |
| Claude Code | `claude/channel/permission` | Router les demandes de permission de tous les agents vers le dashboard, une politique d'org, ou un humain → [C04](C04-channel-permission-relay.md) |

Un projet qui détecte les conflits mais ne peut pas les empêcher vend un rapport. Un projet qui les empêche
vend une garantie. Le passage de l'un à l'autre est maintenant à portée d'API, sur trois surfaces
indépendantes — ce qui limite le pari sur une seule.

> 🛠 **Tranché le 2026-08-15 (ligne `A03`) — la contrainte marche, et c'est son succès qui pose problème.**
> `InputRequiredResult` a été exécuté de bout en bout contre **Claude Code 2.1.233**, via le **shim
> legacy** du SDK v2 (`ServerOptions.inputRequired.legacyShim`, défaut `true`) qui traduit un
> `inputRequired()` en une vraie requête `elicitation/create` **sur une connexion d'ère 2025** — donc
> sans attendre que quiconque adopte `2026-07-28`, et sur le transport que
> [`A02`](A02-mcp-sdk-typescript-v2.md) vient d'adopter.
>
> C'est **le seul** des quatre mécanismes testés où l'acquittement échappe au modèle : avec
> `isError` + un paramètre `acknowledge_conflicts`, c'est le modèle qui se donne l'autorisation (et
> il s'en sert sous pression, 1 fois sur 3) ; avec MRTR, c'est le **client** qui répond. Le tableau
> ci-dessus est donc validé sur sa ligne `A03` — la contrainte est réelle.
>
> **Mais en mode non interactif, `claude -p` répond `{"action":"cancel"}` sans consulter le
> modèle**, et il n'existe **aucun chemin de forçage** pour un agent non surveillé : écriture
> bloquée 3/3. Or essaim, CI, sessions background et `/batch` sont le profil d'usage central du
> projet. La question ouverte n'est pas technique, elle est produit : *que doit faire un agent non
> surveillé face à un conflit `warning` ?* Tant qu'elle n'est pas tranchée, `A03` est **reportée**.
>
> Deux corrections de cadrage pour cette section : MRTR ne se déclenche **que** sur `tools/call`
> (« Servers **MUST NOT** send `InputRequiredResult` responses on any other client requests ») — il
> ne peut donc rien contre l'agent qui n'annonce pas, ce qui reste le domaine de
> [`C06`](C06-tool-search-defer-loading.md) et [`C01`](C01-hook-mcp-tool-gate.md). Et le « sans
> table serveur » qu'on prête à `requestState` est faux pour un acquittement : la spec exige la
> garantie d'usage unique **côté serveur**. Détail en §6.4 et §7 de
> [`A03`](A03-mrtr-input-required.md).

### Mouvement 2 — Payer la dette de protocole

C'est la seule partie de cette veille qui a une horloge. Le transport implémenté par `src/serve-http.ts` et
`src/sse-emitter.ts` est officiellement déprécié ; les hypothèses de session sur lesquelles le daemon repose
sont supprimées du cœur ; le SDK cible n'existe plus sous son nom actuel. Sans migration, le serveur devient
progressivement un serveur legacy 2025 pour les clients récents.

La contrepartie est réelle et vaut d'être dite : le stateless permet de déployer le daemon derrière un simple
round-robin, sans affinité de session ni store partagé — ce qui simplifie franchement le mode HTTP/Docker.
→ [A01](A01-mcp-2026-07-28-stateless.md), [A02](A02-mcp-sdk-typescript-v2.md),
[A04](A04-subscriptions-listen.md), [A06](A06-tool-metadata-modern-surface.md)

> 🛠 **Tranché le 2026-08-15 — « la seule partie qui a une horloge » n'en a pas, et le vrai bénéfice
> est ailleurs que là où cette section le cherche.**
>
> **(1) Il n'y a pas d'horloge.** `/specification/2026-07-28/deprecated`, fetchée le 2026-08-15 :
> section **« Removed » vide**, HTTP+SSE « Three months after SEP-2596 reaches Final » (non daté),
> Roots/Sampling/Logging/DCR « First revision released on or after **2027-07-28** ». Et surtout, le
> **repli fonctionne** : un client `@modelcontextprotocol/client@2.0.0` en `mode: 'auto'` — celui
> qui sonde `server/discover` — se connecte au daemon actuel **en 33 ms et liste ses 26 outils**.
> Seul `{ pin: '2026-07-28' }`, qui refuse tout repli, échoue. « Devenir un serveur legacy 2025 »
> est exact et **sans conséquence fonctionnelle mesurable**.
>
> **(2) « Le SDK cible n'existe plus sous son nom actuel » est faux** (déjà corrigé en §6 de ce
> document, mais §1 et §2 le répètent) : `@modelcontextprotocol/sdk@1.30.0` est publié — le
> **2026-07-27 à 17h56**, six heures avant la famille v2 du même jour.
>
> **(3) Le bénéfice réel de la migration SDK n'est pas le protocole, c'est l'arbre de dépendances.**
> Mesuré `pnpm ls --prod --depth Infinity` sur un worktree migré par le codemod officiel :
> **189 → 120 paquets de production, −74 / +4**. Sortent notamment `express@5`, `cors`,
> `express-rate-limit`, `ajv`, `ajv-formats`, `raw-body`, `zod-to-json-schema` — que ce dépôt, un
> `node:http` nu, **n'importe nulle part**. Coût mesuré du chemin : 108 changements automatiques
> sur 21 fichiers, **6 erreurs `tsc` dont 0 dans `src/`**, **48/49 tests**, daemon fonctionnel.
>
> **(4) Le « gain multi-instance » ne se matérialise pas, et on sait pourquoi.** Porter les claims
> par requête ne débloque aucun round-robin tant que `sessionIdGenerator` est fourni ; le stateless
> impose un transport + un `McpServer` **neufs par requête HTTP**. Et SQLite + le broker MQTT
> embarqué restent les vrais points de sérialisation.
>
> **Verdicts :** [`A01`](A01-mcp-2026-07-28-stateless.md) **reporter** (tier T1 → **T2**) ;
> [`A02`](A02-mcp-sdk-typescript-v2.md) **adopter partiellement** — le changement de paquets, pas la
> révision (nature `replace-homemade-code` → **`reduce-dependency-surface`**, effort `XL` → **M**).
> Détail en §6.4 et §7 des deux fiches.
>
> **(5) Capacité v2 ≠ trafic v2 — et c'est mesuré sur le fil.** Le changelog officiel de Claude Code
> donne « protocol-version **probe** » en **2.1.232** et « **MCP v2** … **subscriptions/listen** »
> en **2.1.233** : Claude Code **est** un client de la révision. Le poste a donc été mis à jour
> (2.1.219 → **2.1.233**) et la session rejouée à travers un proxy d'écoute. Résultat :
>
> ```
> >>> POST /mcp  initialize  protocolVersion: "2025-11-25"  clientInfo: claude-code 2.1.233
> >>> POST /mcp  notifications/initialized     mcp-session-id: b688aca8-…
> >>> GET  /mcp  (endpoint que la revision supprime)
> >>> POST /mcp  tools/list  -> 26 outils      >>> tools/call list_agents -> OK   (9 s)
> ```
>
> **Aucun `server/discover`. Aucune sonde. `2025-11-25` sur le fil.** Le binaire « MCP v2 »
> négocie l'ère legacy avec notre daemon et utilise même l'endpoint GET que la révision retire.
> Conséquence : la mesure de [`A04`](A04-subscriptions-listen.md) est **re-confirmée**, pas périmée.

Un cas mérite d'être isolé : **`subscriptions/listen`**. Le broker MQTT embarqué, `src/mqtt-bridge.ts` et
`src/sse-emitter.ts` existent en grande partie parce que le push temps réel n'était pas standardisé dans MCP.
Il l'est désormais. La question n'est pas de savoir si le code maison marche — il marche — mais de savoir
combien de temps il vaut de le maintenir face à un canal standard, négocié et compatible load-balancer.
→ [A04](A04-subscriptions-listen.md)

> 🛠 **Tranché le 2026-08-15 — ce paragraphe attribue à `A04` une question qu'elle ne peut pas trancher.**
> `subscriptions/listen` est bloqué **aux deux bouts** : le SDK installé (1.30.0) a **0 occurrence** de la
> révision `2026-07-28` (`LATEST_PROTOCOL_VERSION = '2025-11-25'`), notre serveur rétrograde une demande en
> 2026-07-28 vers 2025-11-25, et Claude Code 2.1.219 envoie `initialize` en 2025-11-25. Le sort du broker
> MQTT, lui, **ne dépend pas de cette révision** et se tranche aujourd'hui — la fiche `A04` mélangeait trois
> questions distinctes (§7.2). **L'ordre de travail est d'ailleurs inversé :** `A04` est conditionnée par
> [`A01`](A01-mcp-2026-07-28-stateless.md)/[`A02`](A02-mcp-sdk-typescript-v2.md), qui portent la migration,
> et non l'inverse. Corrections de classement : tier T1 → **T3**, nature `replace-homemade-code` →
> **opportunity** (le dépôt n'a **aucune** ressource MCP — on n'y remplace rien).
>
> Trois constats extraits, tous indépendants de la révision : le broker **bloque le démarrage** du
> coordinateur si le port 1883 est pris (`serve-http.ts:1386`, sans `try`/`catch`) ; **essaim**, le
> consommateur de référence du bus cité par le README, souscrit à des topics d'avant la v0.7.0 et **ne reçoit
> plus rien depuis** ; et déclarer `capabilities.resources.subscribe: true` sans installer le handler renvoie
> **-32601** — garde-fou fantôme en puissance. Détail en §6.4 et §7 de [A04](A04-subscriptions-listen.md).

### Mouvement 3 — Occuper explicitement ce que le natif ne couvre pas

Le natif d'Anthropic a des trous nets, documentés, et durables. Les nommer publiquement coûte peu et vaut
plus qu'une feature de plus :

- **Windows natif** — le cross-session messaging n'y fonctionne pas (macOS/Linux/WSL2 uniquement).
  Le mainteneur du projet est lui-même sur Windows.
- **Multi-vendeur** — Cursor, Cline et Aider n'apparaîtront jamais dans `claude agents`.
- **Cross-conteneur / cross-machine** — la messagerie native passe par un socket UDS et exige les mêmes
  fichiers ; un broker MQTT + HTTP traverse.
- **Schéma et persistance** — la messagerie native est du texte brut : pas de schéma d'annonce, pas de
  détection de conflit, pas d'historique, pas de dependency-map.
- **Backends non-Anthropic** — Channels, Monitor, cross-session messaging et agent teams n'existent pas sur
  Bedrock, Foundry ni Google Cloud.

→ [C12](C12-portability-matrix.md), et la partie « failles à exploiter » de chaque fiche du bloc D.

---

## 3. La menace principale

**Ce n'est pas qu'Anthropic livre la coordination. C'est que le problème se déplace.**

Si `--worktree` devient le mode de travail par défaut — et tout pousse dans ce sens : c'est GA, c'est intégré
aux subagents, aux sessions background et à `/batch`, et une génération entière d'orchestrateurs tiers
(Conductor, Nimbalyst, Vibe Kanban, Claude Squad) est bâtie sur cette seule idée — alors deux agents ne
travaillent plus jamais sur le même checkout. Le conflit d'écriture simultanée, la douleur que le projet
vend, **disparaît**.

Le pitch « les conflits sont détectés avant qu'une ligne soit écrite » perd sa force face à « chacun a son
checkout, il n'y a plus de conflit ».

La réponse n'est pas de nier le mouvement, c'est de recadrer honnêtement : **un worktree évite la collision
d'écriture, pas le conflit sémantique.** Deux agents qui refactorent la même API dans deux checkouts isolés ne
se marchent pas dessus — ils se découvrent au merge, plus tard, plus cher. C'est ce que mesurent déjà
`dependency-map`, `impact-scorer`, `git-cochange-builder` et `conflict-detector`, et c'est le seul terrain où
l'isolation par worktree n'apporte rien.

Cette reformulation est un travail de positionnement, pas de code. Elle conditionne la valeur de tout le
reste. → [D03](D03-threat-native-worktrees.md), [G02](G02-worktree-orchestrators.md)

> 🛠 **Tranché le 2026-08-15 — cette section se trompe sur les deux points qui comptent.**
>
> **(1) « C'est ce que mesurent déjà `dependency-map`, `impact-scorer`, `git-cochange-builder` et
> `conflict-detector` »** — non. Vérifié commande par commande : le serveur **n'ouvre jamais un
> fichier source du dépôt** (les seuls `readFileSync` de `src/` sont les assets du dashboard et
> `package.json` ; aucun `fs.watch`, aucun `chokidar`) ; `treeSitter.extract()` n'a **qu'un seul
> appelant**, alimenté par un `body.content` **optionnel** poussé par le client ; la dependency-map
> est **intégralement uploadée** (`setMap` ← l'outil MCP `set_dependency_map` ; `setDependencies`
> n'a aucun appelant de production) ; et les quatre signaux de `ConflictDetector` comparent des
> **déclarations d'agent**. La seule observation autonome, `git-cochange`, ne rend que des **noms de
> fichiers commités**, est aveugle au travail en cours (non commité) des worktrees, et
> `COORDINATOR_REPO_ROOT` est absent du `Dockerfile` et du `docker-compose.yml` — donc désactivée
> par défaut. **mcp-coordinator est aujourd'hui un agrégateur de déclarations.**
>
> **(2) « un travail de positionnement, pas de code »** — l'inverse. Le positionnement est **déjà
> écrit** : `docs/index.html:2077` dit mot pour mot « Worktrees isolate filesystems. mcp-coordinator
> coordinates intent. » Ce qui manque, c'est le code.
>
> **La menace n'est donc pas surestimée — elle est sous-spécifiée.** Elle ne dit pas seulement que
> le conflit d'écriture rétrécit ; elle dit que le repli annoncé n'a pas d'implémentation. C'est
> plus grave, et plus actionnable : ça ne dépend d'aucune décision d'Anthropic. Voir §7.1 de
> [D03](D03-threat-native-worktrees.md).

---

## 4. Deux choses à vérifier tout de suite

Ces deux points ne sont pas des opportunités : ce sont des régressions possibles **en production aujourd'hui**.
Ils passent avant toute nouvelle feature.

**Le tool search a peut-être déjà cassé le workflow d'annonce.** Le tool search est activé par défaut dans
Claude Code, et il **diffère** les définitions d'outils MCP. Un agent qui n'a jamais cherché « announce » peut
ne pas savoir que l'outil existe — donc ne jamais annoncer. Avec ~26 outils, le projet est exactement dans la
zone concernée. Le correctif candidat (`alwaysLoad: true` sur le sous-ensemble critique) est peu coûteux ; le
préalable est de **mesurer si la régression est réelle**. → [C06](C06-tool-search-defer-loading.md)

> 🛠 **Mesuré le 2026-08-15 — ce paragraphe est faux, sur les deux points.** (1) Le tool search n'a rien
> cassé : avec `ENABLE_TOOL_SEARCH=false` et les 26 schémas pleinement en contexte, l'agent édite sans
> annoncer. Le workflow ne fonctionnait **pas non plus avant**. (2) Le correctif candidat était le mauvais :
> `alwaysLoad: true` a été testé seul, et avec un impératif dans la description d'`announce_work` — 0/3.
> Ce qui fonctionne est le champ **`instructions`** du serveur (5/5), aujourd'hui absent de
> `createMcpServer()`. Conséquence pour cette section : `C06` n'est pas une régression en production,
> c'est une capacité neuve — et le fait que rien ne contraigne l'annonce **renforce** la priorité du
> Mouvement 1 ([`C01`](C01-hook-mcp-tool-gate.md), [`F02`](F02-canusetool-distributed-lock.md)) au lieu
> de la réduire. Détail et sorties brutes en §6.4 et §7.3 de [C06](C06-tool-search-defer-loading.md).

**Le sandbox Bash bloque probablement l'onboarding en silence.** Le sandbox de Claude Code (GA sur macOS et
Linux) applique un egress deny-by-default. Un daemon écoutant sur `localhost` n'est pas joignable sans une
entrée explicite dans `sandbox.network.allowedDomains`. L'utilisateur ne voit pas une erreur de configuration :
il voit un coordinateur qui ne répond pas. `cli/doctor.ts` devrait détecter le cas et dire exactement quelle
ligne ajouter. → [C09](C09-bash-sandbox-egress.md)

> 🛠 **Tranché le 2026-08-15 — ce paragraphe est faux sur ses trois affirmations.** (1) *« en silence »* : la
> doc dit que Claude Code **prompt** à la première connexion vers un hôte inconnu ; le refus muet exige
> `strictAllowlist` (settings user/managed/CLI) ou `allowManagedDomainsOnly` (managed) — une organisation
> durcie, pas un auto-hébergeur. (2) *« le daemon n'est pas joignable »* : le sandbox **ne couvre que Bash**.
> `sandbox-environments` écrit *« MCP servers and hooks are separate processes that run unconstrained on the
> host »* — le chemin MCP, donc tout le produit, n'est pas concerné. (3) *« dire quelle ligne ajouter »* : la
> ligne en question est **rapportée inopérante** ([#28018](https://github.com/anthropics/claude-code/issues/28018),
> OPEN — loopback refusé même listé dans `allowedDomains`). Un seul des trois échecs annoncés par la fiche est
> confirmé (`.mcp.json` est un chemin protégé). **Le vrai défaut est ailleurs et n'a rien à voir avec le
> sandbox :** `server start --daemon` écrit le PID et sort `0` sans vérifier que le daemon écoute, et `doctor`
> conseille ensuite de démarrer un serveur dont il vient d'afficher le PID. Détail en §6.4 et §7.4 de
> [C09](C09-bash-sandbox-egress.md).

---

## 5. Où se trouve le levier, par rapport à l'effort

Lecture rapide des 56 dossiers, classés par rapport bénéfice/effort plutôt que par ordre alphabétique.

**Fort levier, effort faible** — à instruire en premier :
[C01](C01-hook-mcp-tool-gate.md) hook `mcp_tool` ·
[C06](C06-tool-search-defer-loading.md) `alwaysLoad` ·
[C08](C08-statusline.md) status line ·
[C09](C09-bash-sandbox-egress.md) sandbox dans `doctor` ·
[C12](C12-portability-matrix.md) matrice de portabilité ·
[A10](A10-registry-servercard-conformance.md) `mcpName` + registre ·
[C05](C05-monitor-websocket-push.md) push par `Monitor`/WebSocket

**Fort levier, effort réel** — les vrais chantiers :
[A01](A01-mcp-2026-07-28-stateless.md) + [A02](A02-mcp-sdk-typescript-v2.md) migration protocole ·
[C07](C07-plugin-marketplace-mcpb.md) distribution par plugin ·
[F01](F01-sdk-in-process-mcp-server.md) serveur MCP in-process ·
[C04](C04-channel-permission-relay.md) relais de permission ·
[A03](A03-mrtr-input-required.md) MRTR

**À trancher avant d'investir ailleurs** — questions de cadrage :
[D03](D03-threat-native-worktrees.md) worktrees ·
[E01](E01-cma-competitive-frontier.md) frontière avec Managed Agents ·
[A04](A04-subscriptions-listen.md) garder ou non le broker MQTT ·
[G03](G03-mcp-interceptors-wg.md) l'interception devient-elle une primitive du protocole

**À surveiller sans agir** : les deux groupes de travail MCP sont les signaux les plus lourds de conséquences.
Si `interceptor` (SEP-1763) est ratifié, la détection de conflit avant écriture devient une primitive standard
que n'importe qui branche sur n'importe quel client — menace existentielle, ou opportunité majeure si le
projet devient l'implémentation de référence. Le WG Triggers & Events dit explicitement que le pub/sub
généraliste est hors périmètre, ce qui laisse la place à un broker embarqué avec garanties d'ordre.
→ [G03](G03-mcp-interceptors-wg.md), [G04](G04-mcp-triggers-events-wg.md)

---

## 6. Ce que la vérification factuelle a changé

Une seconde passe (2026-08-14, après rédaction) a confronté chaque fiche à la doc officielle et au code
réel du dépôt. Résultat : **aucune fiche compromise**, mais **379 corrections** sur 44 des 56 fiches.
Le détail est en section 0 de chaque fiche, le bilan dans [README.md](README.md).

Quatre corrections changent une décision, pas seulement une formulation :

- **[A02](A02-mcp-sdk-typescript-v2.md)** — le fait central était faux. `StreamableHTTPServerTransport` ne
  disparaît pas en v2 : il est scindé en deux successeurs directs que le codemod renomme 1:1. Il existe donc
  un chemin de migration à faible effort qui ne passe pas par `createMcpHandler`. Une fiche XL cadrée
  « réécriture » redevient un choix entre deux stratégies.
- **[C06](C06-tool-search-defer-loading.md)** — la doc tranche : *« Only tool names and server instructions
  load at session start »*. Les **descriptions** d'outils ne sont donc pas visibles au premier tour. Et il
  existe un levier **côté serveur** que la fiche ignorait — `"anthropic/alwaysLoad": true` dans le `_meta`
  d'un outil — donc le correctif ne dépend pas de ce que les utilisateurs écrivent dans leur `.mcp.json`.
- **[C09](C09-bash-sandbox-egress.md)** — les clés de configuration étaient au mauvais niveau
  (`sandbox.network.allowUnixSockets`, pas `sandbox.allowUnixSockets`), une clé manquait
  (`allowLocalBinding`), et la forme `"127.0.0.1:3100"` n'est **pas** documentée — seule la forme IPv6
  crochetée l'est. Une session de challenge aurait été perdue sur ces trois erreurs.
- **[D03](D03-threat-native-worktrees.md)** — le hook `WorktreeCreate` ne reçoit **pas** le chemin du
  worktree, seulement un `name` (slug). Ce que la fiche proposait de construire dessus n'est pas
  constructible tel quel.

## 7. Limites de cette veille

À dire clairement, parce que la suite en dépend :

- **Rien n'a été exécuté.** La vérification a porté sur la doc et sur le code du dépôt, pas sur le
  comportement du daemon en marche. Aucune mesure, aucun PoC. C'est l'objet des challenges.
- **17 fiches se tranchent par un PoC local**, les 39 autres seulement partiellement — la partie non
  testable est nommée dans la section 0 de chaque fiche. Aucune n'est totalement bloquée, contrairement
  à ce que laissait craindre le bloc E.
- **13 marqueurs `(à vérifier)` subsistent** sur 9 fiches (`C01`, `C07`, `C09`, `C12`, `D03`, `D04`,
  `E08`, `E11`, `F02`) : la doc n'y répond pas, seule l'expérience tranchera.
- **Le cutoff du modèle est mai 2026.** Les trois derniers mois ont été couverts par recherche web
  uniquement — c'est la zone où la confiance est la plus faible et où une source a pu manquer.
- **6 fiches sont marquées PLAUSIBLE et non CONFIRMED** par le vérificateur : à traiter avec prudence.
- **Une fiche a été réfutée** sur son contenu (`G02`, orchestrateurs tiers) : le vérificateur a corrigé des
  affirmations fausses sur les API publiques de ces outils et sur leur statut commercial. La fiche a été
  conservée avec les corrections, mais elle mérite une relecture attentive.
- **Le classement en tiers est mon jugement**, pas un résultat de la recherche. Il est fait pour être
  contesté lors des challenges.

---

## Index

Voir [README.md](README.md) pour la liste complète des 56 dossiers, leur statut de challenge et leur
question à trancher.
