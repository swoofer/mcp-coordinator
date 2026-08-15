# C09 — Sandbox Bash et egress : l'échec d'onboarding silencieux à corriger

| Champ | Valeur |
|---|---|
| **ID** | `bash-sandbox-egress` |
| **Surface** | claude-code |
| **Statut** | GA (sous-options `tlsTerminate` expérimentales) |
| **Disponible depuis** | GA, intégré au binaire ; `network.tlsTerminate` expérimental v2.1.199+, `strictAllowlist` v2.1.219+, `credentials.sigv4` v2.1.224+, forme IPv6 entre crochets v2.1.229+ |
| **Tier** | T1-incontournable |
| **Nature** | threat |
| **Effort estimé** | S |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — sandbox inexistant sous Windows natif, WSL2 requis |
| **Statut du challenge** | ⬜ à faire |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- **Chemin des clés Unix sockets corrigé** : ce sont `sandbox.network.allowUnixSockets` (macOS **uniquement**, ignoré sur Linux/WSL2) et `sandbox.network.allowAllUnixSockets` (défaut `false`), pas `sandbox.allowUnixSockets` / `sandbox.allowAllUnixSockets`. Corrigé en §1 et §2. Conséquence directe sur la §6.1 : le pari « socket Unix » repose sur une clé macOS-only, et sous Linux/WSL2 il n'existe que l'interrupteur global `allowAllUnixSockets`.
- **Clé manquante ajoutée : `sandbox.network.allowLocalBinding`** (« Allow binding to localhost ports (macOS only). Default: false »). Elle tranche en partie le point « (à vérifier) » sur le *bind* : sur macOS, un processus lancé depuis un Bash sandboxé ne peut pas écouter sur un port loopback par défaut.
- **`allowedDomains` avec port** : la doc ne documente le suffixe de port que pour la **forme IPv6 entre crochets** (`"[::1]"` / `"[::1]:443"`, v2.1.229+). La forme IPv4 `"127.0.0.1:3100"` n'est documentée nulle part ; la §1 l'affirmait comme un fait. Reformulé en fait non établi.
- **`strictAllowlist` précisé** : n'est honoré que depuis les settings **user, managed ou `--settings` CLI** — le poser dans `.claude/settings.json` ou `.claude/settings.local.json` du dépôt n'a **aucun effet**. La §1 laissait croire qu'un projet pouvait l'activer.
- **Chemins protégés complétés** : la liste officielle inclut aussi `.claude/agents` et `.claude/commands`. Et l'affirmation « aucun `allowWrite` ne peut rouvrir » est exacte, avec une exception : `sandbox.filesystem.disabled` désactive toute la couche fichiers.
- **Clés de contexte ajoutées en §2** : `sandbox.enabled` (défaut **false**), `failIfUnavailable`, `autoAllowBashIfSandboxed`, `network.enableWeakerNetworkIsolation`. Le sandbox est donc **opt-in**, ce qui module la gravité annoncée en §4.
- Statut « GA (sous-options expérimentales) » **confirmé** : le sandbox est intégré au binaire, macOS/Linux/WSL2, Windows natif non supporté ; `tlsTerminate` est explicitement marqué *Experimental*. Numéros de version des sous-options tous confirmés (v2.1.199 / v2.1.219 / v2.1.224 / v2.1.229).
- **§5 : aucune correction.** Les 10 fichiers cités existent et **tous** les numéros de ligne pointent bien sur ce que la fiche prétend (`doctor.ts` 18/33/825/910-918 et le hint « Start the server… » ; `init.ts` 100-103/247/253-292 ; `channel.ts` 8/522-527 avec le défaut `mqtt://127.0.0.1:1883` ; `serve-http.ts` 1397/1401 ; `dashboard.ts` 21/25-31 ; `sdk/src/client.ts` 15/38/48/125). L'absence de toute occurrence de « sandbox » dans `README.md`, `docs/troubleshooting.md`, `docs/onboarding-self-host.md` et `docs/faq.md` est vérifiée.

**Marqueurs `(à vérifier)` restants :** 3, tous reformulés en §2 mais non résolus par la doc.

1. **Serveurs MCP `type: "http"` et le proxy** — non vérifiable par la doc. La doc ne parle que de « the sandboxed Bash tool » et de « all scripts, programs, and subprocesses spawned by commands » ; la ligne `strictAllowlist` précise que la règle vaut « for sandboxed commands only; in-process tools such as WebFetch aren't gated ». Forte présomption que les serveurs MCP spawnés par Claude Code lui-même sont hors sandbox, mais aucune phrase ne le dit. Reste le test qui décide de la gravité.
2. **MQTT TCP brut à travers le proxy** — non vérifiable par la doc. Seul indice : le relais utilisé sur Linux/WSL2 est `socat`, générique TCP, mais l'allowlist est appliquée sur le **hostname demandé**, ce qui suppose un protocole où le client annonce un hôte.
3. **Effet du sandbox sur un processus qui écoute** — partiellement tranché : `network.allowLocalBinding` existe et vaut `false` par défaut, mais **macOS uniquement**. Rien de documenté pour Linux/WSL2.

**Testabilité :** ⚠️ partielle
La moitié « code repo » est entièrement testable ici : lecture de `~/.claude/settings.json` et `.claude/settings*.json`, détection de `sandbox.*`, réécriture du hint de `doctor`, catch EPERM/EACCES dans `cli/init.ts` — tout cela se code et se teste sous Windows avec le daemon local. La moitié « comportement réel du sandbox » (prompt vs refus, forme `127.0.0.1:3100`, MQTT TCP, serveur MCP HTTP, bind) est **inexécutable sur le poste principal** : Windows natif n'est pas supporté, il faut une distribution WSL2 avec Claude Code, `bubblewrap` et `socat` installés dedans, plus Node 22 + le daemon dans ce même WSL2.

---

## 1. Ce que c'est

Claude Code exécute l'outil Bash dans un bac à sable OS (Seatbelt sur macOS, namespaces sur Linux et WSL2 — **pas de Windows natif**), avec deux dimensions de confinement : le système de fichiers et le réseau. Côté réseau, le trafic sortant du sandbox est routé vers un proxy HTTP/SOCKS qui vit hors du sandbox et décide d'autoriser ou non en fonction du **hostname** fourni par le client, pas de l'IP résolue. Le sandbox est **opt-in** (`sandbox.enabled`, défaut `false`). Aucun domaine n'est pré-autorisé : la première connexion vers un hôte inconnu déclenche un prompt utilisateur, et si `sandbox.network.strictAllowlist` vaut `true` (ou `allowManagedDomainsOnly` en managed settings), elle est **refusée sans prompt** — `strictAllowlist` n'étant honoré que depuis les settings user, managed ou `--settings` CLI, jamais depuis le `.claude/settings.json` d'un dépôt. L'allowlist se déclare dans `settings.json` sous `sandbox.network.allowedDomains`, qui supporte les wildcards et les littéraux IPv6 entre crochets avec port optionnel — `"[::1]"` / `"[::1]:3100"` (v2.1.229+). *Que la forme IPv4 avec port `"127.0.0.1:3100"` soit acceptée n'est documenté nulle part* (à tester). Les sockets Unix sont un canal distinct, gouverné par `sandbox.network.allowUnixSockets` (**macOS uniquement**, ignoré sur Linux/WSL2) et `sandbox.network.allowAllUnixSockets` (défaut `false`, seul levier sous Linux/WSL2). L'écoute sur un port loopback depuis le sandbox a sa propre clé, `sandbox.network.allowLocalBinding` (**macOS uniquement**, défaut `false`). Côté fichiers, le sandbox interdit toute écriture dans `.mcp.json`, `.claude/settings*`, `.claude/hooks`, `.claude/skills`, `.claude/agents`, `.claude/commands`, `.claude/workflows` et `.claude/scheduled_tasks.json` — un ensemble de chemins protégés qu'aucun `allowWrite` ni règle `Edit(...)` ne peut rouvrir (seul `sandbox.filesystem.disabled`, qui coupe toute la couche fichiers, les lève). Des échappatoires existent par commande (`sandbox.excludedCommands`, `sandbox.allowUnsandboxedCommands`) et la commande `/sandbox` affiche l'état courant.

**Ce qui casse pour nous** : un agent dont le Bash est sandboxé ne joint pas le daemon mcp-coordinator sur `127.0.0.1:3100` (ni `[::1]`, ni le broker MQTT sur `:1883`) tant que l'adresse n'est pas dans l'allowlist — et `mcp-coordinator init --write-mcp-config .` ne peut pas écrire `.mcp.json` depuis un Bash sandboxé, quelle que soit la config filesystem.

## 2. Surface d'API exacte

```
settings.json                             // noms confrontés à code.claude.com/docs/en/settings le 2026-08-14
  sandbox.enabled                         // défaut false — le sandbox est opt-in
  sandbox.failIfUnavailable               // échec au démarrage si le sandbox ne peut pas démarrer
  sandbox.autoAllowBashIfSandboxed        // défaut true
  sandbox.network.allowedDomains          // wildcards + IPv6 crochets ["[::1]", "[::1]:3100"] (v2.1.229+)
  sandbox.network.deniedDomains           // prioritaire sur allowedDomains
  sandbox.network.strictAllowlist         // true = refus sans prompt (v2.1.219+) — user/managed/--settings SEULEMENT
  sandbox.network.allowManagedDomainsOnly // managed settings uniquement
  sandbox.network.tlsTerminate            // Experimental (v2.1.199+) — user/managed/--settings seulement
  sandbox.network.httpProxyPort
  sandbox.network.socksProxyPort
  sandbox.network.allowUnixSockets        // macOS UNIQUEMENT (ignoré Linux/WSL2)
  sandbox.network.allowAllUnixSockets     // défaut false — seul levier sous Linux/WSL2
  sandbox.network.allowLocalBinding       // « bind to localhost ports », macOS UNIQUEMENT, défaut false
  sandbox.network.enableWeakerNetworkIsolation
  sandbox.excludedCommands
  sandbox.allowUnsandboxedCommands
  sandbox.filesystem.{allowRead,denyRead,allowWrite,denyWrite,disabled,allowManagedReadPathsOnly}
  sandbox.credentials.{files,envVars,allowPlaintextInject,awsPairs,sigv4}

commande interactive : /sandbox   (onglets Mode / Overrides / Config, + Dependencies sous Linux)
variable d'env       : CLAUDE_CODE_SUBPROCESS_ENV_SCRUB
```

Entrée minimale à faire ajouter par l'utilisateur pour que le daemon soit joignable depuis un Bash sandboxé — **forme à valider par le test**, la doc ne documente le port que pour la forme IPv6 entre crochets :

```json
{
  "sandbox": {
    "network": {
      "allowedDomains": ["127.0.0.1:3100", "[::1]:3100", "127.0.0.1:1883"]
    }
  }
}
```

Points non vérifiés, à ne pas affirmer dans la doc tant qu'ils ne sont pas testés :

- Le sandbox s'applique à l'outil Bash. **Savoir si les serveurs MCP déclarés dans `.mcp.json` (`type: "http"`, spawnés par Claude Code lui-même) traversent le même proxy est (non vérifiable par la doc)** — la doc ne couvre que « the sandboxed Bash tool » et les sous-processus des commandes sandboxées, et précise pour `strictAllowlist` : « Enforced for sandboxed commands only; in-process tools such as `WebFetch` aren't gated ». Forte présomption que les serveurs MCP sont hors sandbox, aucune phrase ne le dit. C'est le point qui décide de la gravité réelle pour nous.
- Le proxy est décrit comme HTTP/SOCKS et s'appuie sur `socat` côté Linux/WSL2 ; qu'un flux **MQTT en TCP brut** vers `:1883` puisse le traverser est **(non vérifiable par la doc)** — l'allowlist est appliquée sur le hostname demandé par le client.
- L'effet du sandbox sur un processus qui **écoute** est **partiellement tranché** : `sandbox.network.allowLocalBinding` existe, vaut `false` par défaut et interdit le bind sur un port loopback — mais **macOS uniquement**. Le comportement sous Linux/WSL2 est **(non vérifiable par la doc)**.
- La forme IPv4 avec port dans `allowedDomains` (`"127.0.0.1:3100"`) est **(non vérifiable par la doc)** : seul le couple hôte/port en forme IPv6 crochetée est spécifié. La section IPv6 laisse entendre qu'un suffixe `:port` numérique est bien lu comme un port sur une entrée non crochetée, sans le garantir pour IPv4.
- Le bundle ne contient qu'une seule fiche brute (un seul chercheur) : pas de contradiction entre sources, mais pas non plus de recoupement.

## 3. Sources

- https://code.claude.com/docs/en/sandboxing
- https://code.claude.com/docs/en/sandbox-environments
- https://code.claude.com/docs/en/settings

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :**
Le gain n'est pas une capacité nouvelle, c'est la suppression d'un mode d'échec muet à l'onboarding. Concrètement : `mcp-coordinator doctor` sait déjà dire « `127.0.0.1:3100` unreachable » (`cli/doctor.ts`, check `tcp-<port>`), mais son `hint` actuel est « Start the server: mcp-coordinator server start --daemon » — un conseil faux et coûteux quand le serveur tourne et que c'est le sandbox qui coupe. Ajouter une détection de sandbox actif et remplacer ce hint par l'entrée exacte à coller dans `settings.json` transforme un debug d'une heure en une ligne de config. Cible : tout utilisateur macOS/Linux/WSL2, c'est-à-dire la majorité de la base hors Windows, et c'est la trajectoire par défaut de Claude Code vers plus d'autonomie. Le même diagnostic sert le chemin `init` : `--write-mcp-config` échouera sur un chemin protégé sans que l'utilisateur comprenne pourquoi.

**Risque si on ne fait rien :**
Élevé et déjà actif. Trois échecs distincts, tous silencieux ou mal diagnostiqués :
1. **Connexion** — l'agent ne joint pas le daemon en loopback ; avec `strictAllowlist: true` il n'y a même pas de prompt, juste un refus. L'utilisateur conclut que mcp-coordinator ne marche pas.
2. **Install** — `mcp-coordinator init --write-mcp-config .` ne peut pas écrire `.mcp.json` depuis un Bash sandboxé. Le README (`## Getting started`, étape 2) documente exactement ce geste.
3. **Push temps réel** — `mcp-coordinator channel` se connecte en MQTT TCP à `mqtt://127.0.0.1:1883` (`cli/channel.ts:527`), un protocole qui n'est pas HTTP. Si le proxy ne le route pas, la fonctionnalité Channels est morte sous sandbox, sans message d'erreur explicite.

Aucun de ces trois points n'est documenté : `sandbox` n'apparaît nulle part dans `README.md`, `docs/troubleshooting.md`, `docs/onboarding-self-host.md` ni `docs/faq.md`.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `cli/doctor.ts` (`tcpReachable` l.18, `httpGet` l.33, `createDoctorCommand` l.825, check `tcp-${port}` l.910-918) | Ajouter une sonde `claude-sandbox` : lire `~/.claude/settings.json` + `.claude/settings*.json` du projet, détecter `sandbox.*`, et si l'hôte/port sondé n'est pas dans `allowedDomains`, remplacer le hint « Start the server… » par l'entrée JSON exacte à ajouter. C'est le point d'entrée principal, effort S. |
| `cli/init.ts` (option `--write-mcp-config` l.100-103, écriture l.220-251) | `writeFileSync` sur `<path>/.mcp.json` (l.247) est sur un chemin protégé par le sandbox : catch l'EPERM/EACCES et afficher le snippet à coller manuellement plutôt qu'un stack trace. Idem pour la branche `--write-claude-md` (l.253-292) — `CLAUDE.md` n'est pas dans la liste protégée, à confirmer. |
| `cli/channel.ts` (l.8 doc, résolution broker l.522-527, défaut `mqtt://127.0.0.1:1883`) | MQTT TCP brut vers loopback : chemin le plus exposé au proxy HTTP/SOCKS. À tester en premier ; sinon documenter `sandbox.excludedCommands` ou l'option socket Unix. |
| `src/serve-http.ts` (l.1397 `const bindHost = process.env.COORDINATOR_BIND?.trim() \|\| "127.0.0.1"` ; `listen` l.1401) | Le bind par défaut est exactement l'adresse que le sandbox bloque à la sortie. Si on décide d'exposer un socket Unix comme transport alternatif, c'est ici que ça se branche. |
| `cli/dashboard.ts` (URL `http://localhost:<port>/dashboard` l.21, spawn `open`/`xdg-open` l.25-31) | Ouvre un navigateur hors sandbox : probablement non impacté, mais `localhost` vs `127.0.0.1` est une différence de hostname que le proxy traite littéralement. À vérifier. |
| `sdk/src/client.ts` (`baseUrl` l.15/38/48, appels `this.fetch` l.125+) | Un consommateur du SDK exécuté depuis un Bash sandboxé tombe sur le même mur. Les erreurs réseau devraient mentionner la piste sandbox dans `sdk/src/errors.ts`. |
| `docs/troubleshooting.md` (sections numérotées, §1 ports, §4 « MQTT client can't connect », §9 « Windows notes ») | Nouvelle section dédiée « Claude Code sandbox » avec le JSON exact ; §4 doit renvoyer vers elle. |
| `README.md` (`## Getting started` l.52-77, `### Real-time push via Claude Code Channels` l.106) | Une ligne d'avertissement à l'étape 2/3 : si Claude Code tourne en mode sandbox, ajouter l'adresse à `allowedDomains` avant de tester. |
| `examples/channels-quickstart/.mcp.json.sample` + `examples/channels-quickstart/README.md` | Le quickstart Channels est le scénario le plus susceptible d'échouer sous sandbox : y ajouter la note. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Faut-il que `doctor` devienne prescripteur de la configuration Claude Code (détecter le sandbox, lire `settings.json` et dicter l'entrée `allowedDomains` à ajouter), ou faut-il supprimer le problème à la source côté transport — exposer un socket Unix en plus du bind `127.0.0.1` de `src/serve-http.ts:1397`, en pariant sur `sandbox.allowUnixSockets` — sachant que le socket Unix ne résout ni le cas WSL2/Windows ni le MQTT TCP de `cli/channel.ts` ?

### 6.2 Hypothèse

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

<Proposition de la veille — à valider ou remplacer en session de challenge.>

> ⚠️ Aucun de ces cinq essais n'est exécutable sous Windows natif : il faut une distribution WSL2 avec Claude Code, `bubblewrap` et `socat` installés, plus Node 22 et le daemon dans ce même WSL2.

- [ ] Sur une machine macOS ou WSL2, activer le sandbox Bash (`/sandbox`), démarrer le daemon hors sandbox, puis lancer `curl http://127.0.0.1:3100/health` depuis l'outil Bash : noter s'il y a prompt, refus silencieux, ou passage.
- [ ] Répéter avec `sandbox.network.strictAllowlist: true`, puis avec `allowedDomains: ["127.0.0.1:3100"]` : confirmer que la forme avec port suffit et que `localhost` n'est pas équivalent à `127.0.0.1`.
- [ ] Vérifier si un serveur MCP `type: "http"` déclaré dans `.mcp.json` et pointant sur `http://localhost:3100/mcp` est soumis au même proxy que Bash (point (à vérifier) de la §2) — c'est ce test qui décide de la gravité.
- [ ] Lancer `mcp-coordinator channel` depuis un Bash sandboxé et vérifier si la connexion MQTT TCP vers `127.0.0.1:1883` passe le proxy ; si non, tester `sandbox.excludedCommands`.
- [ ] Exécuter `mcp-coordinator init --write-mcp-config .` depuis un Bash sandboxé et capturer l'erreur exacte (code errno, message) pour écrire le catch de `cli/init.ts`.

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **Ce n'est pas notre bug.** La configuration du sandbox appartient à Claude Code et à l'utilisateur. Faire lire `~/.claude/settings.json` par `doctor` crée un couplage à un format de fichier tiers, non versionné pour nous, qui bougera (les sous-options ont déjà changé quatre fois entre v2.1.199 et v2.1.229). Chaque changement de schéma côté Anthropic devient une fausse alerte ou un faux OK chez nous.
- **Portabilité.** `doctor` est aujourd'hui agnostique du client MCP : il sonde des ports et des endpoints. Y injecter une sonde spécifique Claude Code brise cette neutralité alors que le README revendique explicitement Cursor et Cline comme clients supportés.
- **Windows.** Le mainteneur développe sous Windows natif, où le sandbox n'existe pas. Le bug est donc invérifiable sur la machine principale : tout le travail se fait à l'aveugle ou dans WSL2, ce qui gonfle le coût réel bien au-delà du « S » annoncé.
- **YAGNI / preuve d'usage manquante.** Aucun ticket ni retour utilisateur ne fait état de cet échec à ce jour. C'est une menace déduite de la doc, pas observée. Un paragraphe dans `docs/troubleshooting.md` — coût ≈ 20 minutes — couvre peut-être 90 % du risque, et le code dans `doctor` peut attendre le premier rapport réel.
- **Le socket Unix est une fausse bonne idée.** Ajouter un transport à `src/serve-http.ts` pour contourner l'allowlist, c'est une deuxième surface d'écoute à sécuriser (permissions du fichier socket, tests, doc, `doctor`), qui ne couvre ni WSL2 ni le MQTT de `cli/channel.ts` — donc du code en plus sans supprimer la doc à écrire de toute façon.
- **Dépendance à des flags mouvants.** `tlsTerminate` est marqué expérimental et la syntaxe IPv6 entre crochets n'est arrivée qu'en v2.1.229 : documenter une recette précise nous engage à la maintenir version par version, ou à publier une doc fausse pour les utilisateurs en retard de version.

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
| 2026-08-14 | Vérification des faits : clés Unix sockets sous `network.*`, `allowLocalBinding` ajoutée, §5 intégralement exacte. |
