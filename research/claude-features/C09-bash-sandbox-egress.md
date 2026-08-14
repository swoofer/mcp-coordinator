# C09 — Sandbox Bash et egress : l'échec d'onboarding silencieux à corriger

| Champ | Valeur |
|---|---|
| **ID** | `bash-sandbox-egress` |
| **Surface** | claude-code |
| **Statut** | GA (sous-options `tlsTerminate` expérimentales) |
| **Disponible depuis** | GA, intégré au binaire ; `network.tlsTerminate` expérimental v2.1.199+, `strictAllowlist` v2.1.219+, `credentials.sigv4` v2.1.224+, forme IPv6 entre crochets v2.1.229+ |
| **Tier** | T1-incontournable |
| **Nature** | threat |
| **Effort estimé** | ~~S~~ → **M** (recalibré au challenge du 2026-08-15, voir §6.5-bis (3)) |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — sandbox inexistant sous Windows natif, WSL2 requis |
| **Statut du challenge** | ✅ **tranché** (2026-08-15) — adopter partiellement, voir §7 |

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

**Pré-enregistré le 2026-08-15, avant tout test.** Environnement : Claude Code **2.1.219**,
Node 22.21.0, Windows 11 natif.

**État de la testabilité, établi par recon avant de commencer :**

- WSL2 est présent (`Ubuntu`, version 2, `Stopped`) — mais la distribution est **vide** :
  `bwrap`, `socat`, `node`, `npm`, `claude`, `curl` sont **tous absents**, et `sudo -n true`
  répond « a password is required ». Installer les prérequis exigerait un mot de passe
  interactif que la session n'a pas. **La moitié comportementale du sandbox est donc bloquée,
  et le blocage est nommé.**
- `~/.claude/settings.json` et `settings.local.json` ne contiennent **aucune** clé `sandbox`.

**Hypothèse.** La fiche et la synthèse surestiment la gravité, pour la même raison que `C06` :
elles présentent comme une régression active ce qui est une configuration **opt-in**
(`sandbox.enabled`, défaut `false` — établi en §0). Et surtout, le marqueur `(à vérifier)` n° 1
décide de tout : si les serveurs MCP `type: "http"` sont **hors** sandbox — ce que la doc laisse
fortement présumer en ne parlant que de « the sandboxed Bash tool » — alors le chemin principal
de mcp-coordinator (26 outils MCP) fonctionne sous sandbox, et seuls les chemins Bash
(`curl`, `init --write-mcp-config`, `channel`) sont touchés. La gravité annoncée en §4
(« élevé et déjà actif », trois échecs) s'effondre alors à un seul échec réel, celui de
l'onboarding par Bash.

**Critères de refus, posés avant de mesurer :**

| # | Ce qui tue quoi | Seuil |
|---|---|---|
| K1 | Si `sandbox.enabled` est `true` par défaut, ou si la doc dit que le sandbox s'active seul dans un mode courant, la prémisse « opt-in donc peu grave » tombe et l'urgence de la fiche est confirmée. | lecture de la doc officielle fetchée aujourd'hui |
| K2 | Si le marqueur n° 1 (serveurs MCP `http` dans le sandbox) n'est tranché **ni** par l'exécution **ni** par une source de premier niveau, le volet correspondant est `reporter`, **jamais** `adopter`. | absence de preuve |
| K3 | Si la sonde `doctor` doit lire et interpréter un format de fichier tiers dont le schéma a déjà bougé 4 fois entre v2.1.199 et v2.1.229, le couplage est disqualifiant sauf si la lecture reste **purement indicative** (jamais un verdict `fail`). | design de la sonde |
| K4 | Si `allowUnixSockets` est bien macOS-only, l'option « socket Unix » de §6.1 est morte : elle ne couvre ni Linux, ni WSL2, ni Windows. | §0 l'établit déjà — à confirmer sur la doc |
| K5 | Si le correctif `doctor` touche plus de 3 fichiers ou impose une dépendance nouvelle, l'effort n'est plus S. | > 3 fichiers |
| K6 | Si aucune preuve exécutable n'est atteignable sur **aucun** des deux volets, le verdict est `reporter` avec le blocage nommé. | — |

### 6.3 Protocole de vérification

Amendé le 2026-08-15. Le protocole de la veille supposait un WSL2 équipé ; il ne l'est pas.
Remplacé par une frontière explicite entre ce qui s'exécute ici et ce qui se prouve par la doc.

**Exécutable ici (Windows natif) :**

- [x] **T1** — Comportement de Claude Code 2.1.219 sous Windows quand on lui demande
      `sandbox.enabled: true` via `--settings`. C'est le scénario réel du mainteneur et de tout
      utilisateur Windows ; il n'a jamais été observé.
- [x] **T2** — Lire le code réel de `cli/doctor.ts` : le hint incriminé, la forme du check
      `tcp-<port>`, et le coût exact d'une sonde `sandbox`. Tranche K3 et K5.
- [x] **T3** — Vérifier le chemin `cli/init.ts --write-mcp-config` : que se passe-t-il
      aujourd'hui quand `writeFileSync` échoue ? Stack trace ou message exploitable ?
      Testable sous Windows en rendant la cible non inscriptible.
- [x] **T4** — Inventaire de la surface documentaire réellement absente
      (`sandbox` dans README / troubleshooting / faq / onboarding).

**Non exécutable ici — preuve documentaire de premier niveau uniquement :**

- [x] **T5** — `code.claude.com/docs/en/sandboxing` et `/settings`, fetchés le 2026-08-15 :
      valeur par défaut de `sandbox.enabled` (K1), portée exacte du sandbox (le marqueur n° 1,
      K2), statut macOS-only de `allowUnixSockets` (K4).
- [ ] **Bloqué** — prompt vs refus silencieux, forme `"127.0.0.1:3100"` vs `"[::1]:3100"`,
      MQTT TCP à travers le proxy, bind sous Linux/WSL2. **Blocage : WSL2 vide + `sudo` exige un
      mot de passe interactif ; pas de poste macOS/Linux.** Ces points restent `(à vérifier)`.

### 6.4 Résultat observé

Exécuté le 2026-08-15. Claude Code **2.1.219**, Node 22.21.0, Windows 11 natif.

> **Frontière exécuté / lu — à lire avant tout le reste.**
> **Exécuté ici :** T1 (comportement Windows), T2 (code de `doctor`), T3 (échec d'écriture de
> `.mcp.json`), T4 (surface documentaire). **Lu seulement**, sur doc officielle fetchée le
> 2026-08-15 : la portée du sandbox, le comportement prompt/refus, les chemins protégés, le statut
> macOS-only des sockets Unix. **Non exécuté et non exécutable ici :** tout le comportement réel du
> sandbox en marche. **Blocage nommé :** WSL2 `Ubuntu` est présent mais **vide** — `bwrap`,
> `socat`, `node`, `npm`, `claude`, `curl` tous absents — et `sudo -n true` répond « a password is
> required ». Aucun poste macOS/Linux disponible. Les quatre points `(à vérifier)` sur le
> comportement fin (forme `"127.0.0.1:3100"`, MQTT TCP à travers le proxy, bind sous Linux/WSL2,
> prompt réel) **restent ouverts**.

---

**(A) T5 — le marqueur `(à vérifier)` n° 1 est tranché par la doc, contre ce que dit la §2.**

La §2 affirme : « Forte présomption que les serveurs MCP sont hors sandbox, **aucune phrase ne le
dit** ». La phrase existe, et elle est explicite — mais elle n'est pas sur la page `sandboxing`.
Elle est sur `code.claude.com/docs/en/sandbox-environments`, fetchée le 2026-08-15, section
*Sandboxed Bash tool* :

> « The per-command sandbox does not cover everything that runs in a session:
> * Other built-in tools such as Read, Edit, and WebFetch **run inside the Claude Code process** and
>   do not spawn arbitrary code. Permission rules for path or domain gate them instead.
> * **MCP servers and hooks are separate processes that run unconstrained on the host.** »

Et, dans le tableau comparatif de la même page :

> « The sandboxed Bash tool is built into Claude Code and **restricts only Bash commands. Built-in
> file tools, MCP servers, and hooks still run directly on your host.** »

**Les deux chemins de mcp-coordinator sont couverts par ces deux puces, mais pas par la même.**
Le daemon est déclaré en `type: "http"` : aucun processus n'est spawné, c'est Claude Code qui émet
la requête **en process** — première puce. Le channel est déclaré en `command:` : c'est un
**processus séparé** — seconde puce. Dans les deux cas, hors du sandbox Bash.

L'**échec n° 1 de §4** (« l'agent ne joint pas le daemon en loopback ») est donc **faux** pour le
chemin MCP.

> ⚠️ **Qualificatif obligatoire, et il n'est pas cosmétique.** Tout ce qui précède ne vaut que pour
> le **sandbox Bash intégré**. La même page décrit `@anthropic-ai/sandbox-runtime` :
> *« Running Claude Code through the runtime **constrains every tool, hook, and MCP server** in the
> session, not only Bash »* — et le tableau range dev container, custom container, VM et Claude Code
> on the web dans la même colonne (« the whole Claude Code process »). **Dans ces déploiements, les
> échecs n° 1 et n° 3 redeviennent vrais.** Ne jamais écrire « hors du sandbox » sans « Bash intégré ».

**(B) Le troisième échec tombe pour la même raison.** `examples/channels-quickstart/.mcp.json.sample`
déclare le channel comme une entrée `mcpServers` :

```json
{ "mcpServers": {
    "coordinator":         { "type": "http", "url": "http://localhost:3100/mcp" },
    "coordinator-channel": { "command": "mcp-coordinator", "args": ["channel"] } } }
```

C'est donc Claude Code qui spawne `mcp-coordinator channel`, pas l'outil Bash — le cas exact que la
doc décrit comme tournant « outside the sandbox ». L'**échec n° 3 de §4** (« la fonctionnalité
Channels est morte sous sandbox ») repose sur une prémisse fausse.

**(C) Le caractère « silencieux » est faux par défaut.** Même page, section *Network isolation* :

> « **no domains are pre-allowed by default. The first time a command needs a new domain, Claude
> Code prompts for approval** […] choosing Yes allows the host for the rest of the current session »

Le refus **sans** prompt exige `strictAllowlist: true` — qui, toujours d'après la doc, « Setting it
in a repository's `.claude/settings.json` or `.claude/settings.local.json` **has no effect** » — ou
`allowManagedDomainsOnly` en managed settings. Autrement dit : le scénario « l'utilisateur voit un
coordinateur qui ne répond pas, sans message » suppose une organisation qui a durci la config, pas
un auto-hébergeur solo. **Ceci contredit `00-SYNTHESE.md` §4** (« L'utilisateur ne voit pas une
erreur de configuration : il voit un coordinateur qui ne répond pas »).

**(D) L'échec n° 2 est le seul confirmé — et il l'est doublement.** La liste des chemins protégés
inclut littéralement `.mcp.json` :

> « In your working directory and the directories above it: the `.claude` settings files, the
> `.claude/skills`, `.claude/agents`, `.claude/commands`, and `.claude/hooks` directories,
> **`.mcp.json`**, and the files Claude Code runs on its own »

Et **T3, exécuté ici**, montre ce que l'utilisateur voit aujourd'hui quand cette écriture échoue —
simulé sous Windows par un `.mcp.json` en lecture seule, ce qui produit le même `EPERM` :

```
Config directory: C:\Users\gagno\.mcp-coordinator
Wrote default config:    C:\Users\gagno\.mcp-coordinator\config.json
node:fs:2425
    return binding.writeFileUtf8(
                   ^

Error: EPERM: operation not permitted, open '...\t9init\.mcp.json'
    at writeFileSync (node:fs:2425:20)
    at Command.<anonymous> (file:///.../dist/cli/init.js:216:21)
    at Command.listener [as _actionHandler] (.../commander/lib/command.js:569:17)
    [... 7 lignes d'internes de commander ...]
  errno: -4048,
  code: 'EPERM',
  syscall: 'open',
  path: '...\\t9init\\.mcp.json'
}
Node.js v22.21.0
```

Exit code **1**, exception non rattrapée, aucun message exploitable. Le geste est documenté dans le
README (`## Getting started`, étape 2).

**(E) T1 — ce que voit un utilisateur Windows, exécuté ici.** `claude -p` avec
`--settings '{"sandbox":{"enabled":true,…}}'` sous Windows natif :

```
⚠ Sandbox disabled: sandbox is enabled but the Windows sandbox is not active on this session (feature gate off)
  Commands will run WITHOUT sandboxing. Network and filesystem restrictions will NOT be enforced.
```

Deux choses. D'abord l'avertissement est **explicite et bruyant** : un utilisateur Windows n'est pas
laissé dans le noir. Ensuite, le message ne dit pas « non supporté sur Windows » — il dit
**« the Windows sandbox is not active on this session (feature gate off) »**. La doc écrit
« Native Windows is not supported » ; le binaire, lui, parle d'un **feature gate**. C'est un signal
à surveiller : si le sandbox Windows sort, la plateforme du mainteneur devient concernée, et ce
challenge devra être rejoué.

**(F) T2 — le code réel de `doctor`.** Le hint incriminé, `cli/doctor.ts` :

```ts
const httpUp = await tcpReachable(host, port);
results.push({
  name: `tcp-${port}`,
  ok: httpUp,
  detail: httpUp ? `${host}:${port} accepts connections` : `${host}:${port} unreachable`,
  hint: httpUp ? undefined
    : `Start the server: mcp-coordinator server start --daemon (or check the configured port)`,
});
```

La §4 citait le hint sans son « (or check the configured port) » — correction mineure, le problème
reste : `tcpReachable` ouvre une socket TCP depuis le process `doctor`. Si `doctor` est lancé
**depuis** un Bash sandboxé, la sonde est dans le sandbox alors que le chemin MCP, lui, n'y est pas.
`doctor` peut donc dire « unreachable » sur un daemon parfaitement joignable par l'agent. C'est un
**faux négatif de la sonde elle-même**, pas la panne que la fiche décrivait.

**(G) T4 — surface documentaire, exécuté.** `grep -ci sandbox` : **0** dans `README.md`,
`docs/troubleshooting.md`, `docs/faq.md`, `docs/onboarding-self-host.md`. L'affirmation de §4 tient.

---

**(H) Le correctif que la fiche recommande ne fonctionne probablement pas.** La §2 propose
`allowedDomains: ["127.0.0.1:3100", "[::1]:3100", "127.0.0.1:1883"]`, et `00-SYNTHESE.md` §4
appelle ça « le correctif candidat, peu coûteux ».
[anthropics/claude-code#28018](https://github.com/anthropics/claude-code/issues/28018) — **OPEN**,
ouverte le 2026-02-24, 5 utilisateurs distincts — dit le contraire :

> « The sandbox blocks outbound TCP connections to localhost/127.0.0.1/::1 **even when these are
> listed in `sandbox.network.allowedDomains`**. The `sock.connect()` syscall gets `EPERM` »

Le rapporteur a essayé exactement la config de la §2, `allowLocalBinding: true` compris. Mécanisme
proposé en commentaire : *« claude is running inside an isolated network namespace, so claude's
localhost and the real localhost are different. Claude has a proxy to access resources outside of
its network namespace (that's how `allowedDomains` works). Unfortunately, you almost never want
proxy requests to localhost »*. Les seuls contournements rapportés : `excludedCommands`, ou
`dangerouslyDisableSandbox: true` par appel.

**Statut de cette preuve :** rapport communautaire corroboré, **non vérifié ici** (blocage WSL2), et
possiblement spécifique à Linux/WSL2 — le mécanisme invoqué est le namespace réseau, alors que macOS
utilise Seatbelt. Mais c'est suffisant pour interdire de **prescrire** cette recette : documenter
une remédiation qui envoie l'utilisateur dans une impasse est pire que ne rien documenter.

**(I) Un quatrième scénario, absent de la fiche : démarrer le daemon depuis un Bash sandboxé.**
`README.md` documente `mcp-coordinator server start --daemon` à l'onboarding. Lancé depuis l'outil
Bash, ce processus se heurte à deux murs indépendants, **ni l'un ni l'autre testés ici** :

- **Le bind.** `src/serve-http.ts:1401` fait `listen(port, "127.0.0.1")`, face à
  `sandbox.network.allowLocalBinding` (défaut `false`).
  [#18545](https://github.com/anthropics/claude-code/issues/18545) (CLOSED) rapporte que
  `allowLocalBinding: true` **n'est pas hérité par les petits-enfants** — or un daemon détaché en
  est un.
- **Le filesystem.** Le daemon écrit dans `~/.mcp-coordinator/`, **hors du cwd et hors du répertoire
  temporaire de session**, les deux seules zones inscriptibles par défaut.

C'est un échec plus structurant que celui que la fiche retient, et il n'est dans aucune de ses trois
lignes.

---

**Bilan de gravité — la §4 annonce « élevé et déjà actif, trois échecs » :**

| Échec | Verdict |
|---|---|
| 1. Connexion — l'agent ne joint pas le daemon | **faux** pour le chemin MCP (`type:"http"` en process, `command:` en processus non contraint). Vrai pour un accès **par Bash** (`curl`, scripts SDK, `doctor`) — et là, `allowedDomains` ne le répare probablement pas (H). |
| 2. Install — `.mcp.json` non inscriptible | **vrai**, doublement : chemin protégé par la doc, et T3 mesure un crash avec stack trace, exit 1. Aucune config ne le lève hormis `filesystem.disabled`. |
| 3. Push MQTT — Channels mort sous sandbox | **faux pour le chemin déclaré** (channel spawné par Claude Code). Reste ouvert pour tout accès au broker **depuis Bash**, et la question « MQTT TCP brut à travers le proxy » n'est toujours pas tranchée. |
| 4. **Daemon démarré depuis un Bash sandboxé** (absent de la fiche) | **non testé**, deux murs plausibles et documentés : bind loopback et écriture hors cwd. |

La gravité passe donc de « trois échecs » à **un confirmé, un partiellement vrai, un faux, et un
quatrième que la fiche n'avait pas vu** — pas au « un seul échec » que ce challenge croyait pouvoir
écrire avant la passe adversariale.

### 6.5-bis Ce que la passe adversariale a changé

Deux réfutateurs. Les deux ont marqué, et le second a **remplacé** le périmètre que ce challenge
s'apprêtait à écrire. Vérifications refaites ici, pas reprises sur parole.

**(1) Ma preuve du point (A) était une inférence.** Je citais la section *Protected paths* de
`sandboxing` (« add a hook or MCP server that Claude Code runs outside the sandbox ») — une
subordonnée dans la justification d'une règle de deny-write, qui peut se lire « à la session
suivante ». Les vraies phrases sont sur `sandbox-environments` et ne sont pas ambiguës. §6.4 (A) a
été réécrite avec elles.

**(2) J'allais écrire « un seul échec réel ». C'était faux dans les deux sens** : l'échec n° 3 n'est
faux que pour le chemin déclaré, et il existe un quatrième scénario que la fiche n'avait pas vu
(§6.4 (I)).

**(3) Mon périmètre déclenchait mon propre critère K5.** J'annonçais « S, 3 fichiers ». Compté
ici :

- **12 appels bruts** à `writeFileSync`/`mkdirSync` sans garde, répartis sur quatre fichiers :
  `cli/config.ts:31,32,33,64,65` · `cli/init.ts:247,290,691` · `cli/uninstall.ts:68,107` ·
  `cli/server/start.ts:246,258`. Je n'en avais nommé **qu'un**.
- **Aucun helper d'écriture** dans le dépôt, et `cli/index.ts` n'a **ni** `uncaughtException`,
  **ni** `exitOverride`, **ni** try/catch — vérifié, le grep ne retourne rien. Toute exception d'une
  commande sort en stack trace avec les internes de commander.
- `cli/uninstall.ts:75` affiche `Error reading ${target}` dans un `catch` qui couvre un
  `writeFileSync` (l. 68) et un `rmSync` (l. 65) : **message faux** sur un échec d'écriture.

**(4) Le hint `doctor` que je voulais enrichir est déjà dupliqué, et le vrai défaut est ailleurs.**
`cli/doctor.ts:905` (check `pid-file`) et `:917` (check `tcp-<port>`) portent le même conseil
« Start the server: … ». Or `cli/server/start.ts:246` écrit le fichier PID **immédiatement après le
`spawn`**, avant tout bind, puis :

```ts
writeFileSync(join(configDir, "server.pid"), String(child.pid));
child.unref();
console.log(`Coordinator started in background (PID ${child.pid}, port ${port})`);
console.log(`  Logs: ${logPath}`);
console.log(`  Stop: mcp-coordinator server stop`);
process.exit(0);
```

Aucune vérification que l'enfant a bindé. Donc : message vert, PID écrit, **exit 0**, enfant mort
dans `server.log` — et `doctor` affiche ensuite `pid-file` **[OK]** juste au-dessus de
`tcp-3100` **[FAIL]** dont le hint dit « démarrez le serveur ». C'est le motif **« garde-fou
fantôme »** déjà relevé dans `audit/`.

Et le dépôt le sait : `docs/troubleshooting.md:29` écrit déjà *« `Coordinator started in
background` -- the crash is only visible in `~/.mcp-coordinator/logs/server.log` »*. **Le bind
refusé par le sandbox n'est donc pas un quatrième échec nouveau : c'est une n-ième instance d'une
classe que la doc décrit depuis v1.4 et que le code n'a jamais corrigée.**

**(5) Zéro signalement utilisateur.** `gh issue list --state all --search sandbox` → aucune ;
`--search unreachable` → aucune ; `grep -in "sandbox\|EPERM\|EACCES" CHANGELOG.md` → 0.

**(6) Une section neuve dans `troubleshooting.md` coûte 6 éditions ailleurs.** `docs/index.html`
fige « a **9-section** troubleshooting guide » / « en **9 sections** » / « mit **9 Abschnitten** » /
« de **9 secciones** » / « **9 セクション** » / « **9 个章节** ». Une 10ᵉ section rend la phrase
fausse dans six langues.

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
| **Verdict** | ⬜ adopter · ✅ **adopter partiellement** · ⬜ reporter · ⬜ refuser |
| **Date** | 2026-08-15 |
| **Justification** | Voir §7.1 à §7.4. Les **deux** branches de la question §6.1 sont refusées ; ce qui est adopté est délibérément **non spécifique au sandbox**. |
| **Issue / PR** | à créer — périmètre en §7.2 |
| **Jalon visé** | prochaine mineure |
| **Effort réel** | **M**, pas S — ~6 fichiers dont un fichier de test neuf. Mon premier périmètre déclenchait mon propre K5. |

### 7.1 La question de §6.1 : ni l'une, ni l'autre

**`doctor` prescripteur de la config Claude Code — refusé.** Trois raisons cumulatives :
la panne visée n'existe pas sur le chemin MCP (§6.4 (A)) ; la recette qu'il dicterait est
**rapportée inopérante en amont** ([#28018](https://github.com/anthropics/claude-code/issues/28018),
OPEN — le TCP sortant vers loopback est refusé *même listé* dans `allowedDomains`) ; et lire
`~/.claude/settings.json` couple le projet à un format tiers dont les sous-options ont bougé quatre
fois entre v2.1.199 et v2.1.229. Prescrire une impasse est pire que se taire.

**Le transport socket Unix — refusé.** `allowUnixSockets` est macOS-only ; sous Linux/WSL2 il
n'existe que l'interrupteur global `allowAllUnixSockets` ; rien sous Windows. Et la doc officielle
range les sockets Unix parmi les **vecteurs d'escalade** (*« allowing access to
`/var/run/docker.sock` effectively grants access to the host system »*). Deuxième surface d'écoute à
sécuriser, pour couvrir une plateforme sur trois. K4 est déclenché.

### 7.2 Ce qui est retenu — et pourquoi ce n'est pas une réponse au sandbox

Le levier n'est pas là où la fiche le cherchait. Ce qui suit se justifie **sans le sandbox**, et le
couvre au passage.

1. **`cli/server/start.ts` — vérifier le bind avant d'annoncer le succès.** Sonder le port (ou lire
   le code de sortie de l'enfant sur une courte fenêtre) **avant** d'écrire le PID, d'imprimer
   « Coordinator started in background » et de sortir `0`. C'est la correction à plus fort levier du
   dossier : elle ferme d'un geste `EADDRINUSE`, le crash-au-démarrage, **et** le bind refusé par un
   sandbox — la classe que `docs/troubleshooting.md:29` décrit déjà sans que le code ait bougé.
2. **`cli/doctor.ts` — conditionner le hint de `tcp-<port>` au fichier PID**, au lieu d'y ajouter une
   mention « sandbox ». Si un PID est enregistré et que rien n'écoute, le conseil n'est pas
   « démarrez le serveur » mais « le daemon est mort au démarrage, voir `server.log` ». Zéro
   couplage à Claude Code, et ça supprime le « garde-fou fantôme » de §6.5-bis (4).
3. **Un seul endroit pour EPERM/EACCES**, pas six try/catch dispersés : soit un helper d'écriture
   partagé (il n'en existe aucun), soit un handler dans `cli/index.ts` (qui n'en a aucun). Couvre
   les 12 sites bruts de `config.ts` / `init.ts` / `uninstall.ts` / `start.ts`, dont l'écriture de
   `.mcp.json` mesurée en T3.
4. **`cli/uninstall.ts:75`** — corriger `Error reading ${target}` affiché sur un échec **d'écriture**.
5. **Doc : deux phrases greffées**, pas une section neuve — une dans `troubleshooting.md` §1 (« si
   la commande a été lancée depuis un agent au Bash sandboxé, le bind peut être refusé — vérifiez
   `server.log` ») et une dans §9 *Windows notes*. Une 10ᵉ section rendrait fausse la chaîne
   « 9-section troubleshooting guide » de `docs/index.html` **dans six langues**.

### 7.3 Ce qui est écarté explicitement

- **Une section « Claude Code sandbox » dédiée** : zéro signalement (`gh issue list --search
  sandbox` → aucune ; `CHANGELOG.md` → 0 occurrence), et elle prescrirait une recette rapportée
  inopérante. Condition de réveil : **la fermeture de #28018**, ou le premier utilisateur qui
  signale le cas.
- **Prescrire une forme d'`allowedDomains`** (`"127.0.0.1:3100"` n'est documentée nulle part, et
  #28018 dit que la famille entière ne marche pas en loopback).
- **La sonde qui lit `~/.claude/settings.json`** (voir §7.1).
- **Le socket Unix** (voir §7.1).

### 7.4 Le recadrage

**La gravité annoncée en §4 — « élevé et déjà actif », trois échecs — ne tient pas**, et
`00-SYNTHESE.md` §4 se trompe deux fois :

- *« L'utilisateur ne voit pas une erreur de configuration : il voit un coordinateur qui ne répond
  pas »* — **faux par défaut** : la doc dit que Claude Code **prompt** à la première connexion vers
  un hôte inconnu. Le refus muet exige `strictAllowlist` (settings user/managed/CLI, jamais celui du
  dépôt) ou `allowManagedDomainsOnly` (managed). C'est un scénario d'organisation durcie, pas
  d'auto-hébergeur solo.
- *« Le correctif candidat (`allowedDomains`) est peu coûteux »* — il est surtout **probablement
  inopérant** pour du loopback (#28018).

Et le sandbox est **opt-in** (`sandbox.enabled` défaut `false`, aucune clé `sandbox` dans le
`settings.json` de ce poste), **inexistant sous Windows natif**, et **ne couvre que Bash** — pas les
serveurs MCP, qui sont tout le produit.

**Ce que ce challenge trouve à la place est plus utile que ce qu'il cherchait :** `server start
--daemon` annonce un succès et sort `0` sans jamais vérifier que le daemon écoute, et `doctor`
conseille ensuite de démarrer un serveur dont il vient d'afficher le PID en vert. Le sandbox n'est
qu'un déclencheur de plus d'une classe de pannes que le dépôt documente depuis v1.4 sans l'avoir
corrigée dans le code. **C'est ça, le vrai `C09`.**

**Deux points à surveiller, non tranchés ici :**

- Sous Windows, le binaire ne dit pas « non supporté » mais **« the Windows sandbox is not active on
  this session (feature gate off) »** (§6.4 (E)). Si le sandbox Windows sort du feature gate, la
  plateforme du mainteneur devient concernée et ce challenge doit être rejoué.
- Tout ce qui précède ne vaut que pour le **sandbox Bash intégré**. Sous
  `@anthropic-ai/sandbox-runtime`, dev container, conteneur custom, VM ou Claude Code on the web,
  *« every tool, hook, and MCP server »* entre dans la boîte — et les échecs n° 1 et n° 3
  **redeviennent vrais**. Condition de réveil : le premier utilisateur qui déploie mcp-coordinator
  dans un de ces environnements.

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : clés Unix sockets sous `network.*`, `allowLocalBinding` ajoutée, §5 intégralement exacte. |
| 2026-08-15 | **Challenge tranché : adopter partiellement**, mais les deux branches de la question §6.1 sont **refusées**. Marqueur `(à vérifier)` n° 1 résolu par `sandbox-environments` : *« MCP servers and hooks are separate processes that run unconstrained on the host »* — le chemin MCP, donc tout le produit, est hors du sandbox Bash. Gravité recadrée : sur les trois échecs annoncés, **un vrai** (`.mcp.json` protégé — crash mesuré, stack trace, exit 1), **un partiel**, **un faux**, plus **un quatrième non vu** (daemon démarré depuis un Bash sandboxé). La remédiation recommandée par la fiche et par la synthèse est **rapportée inopérante** (#28018 OPEN : loopback refusé même listé dans `allowedDomains`). Le vrai défaut est ailleurs et n'est pas lié au sandbox : `server start --daemon` écrit le PID et sort `0` sans vérifier le bind, et `doctor` conseille alors de démarrer un serveur dont il affiche le PID — motif « garde-fou fantôme », déjà décrit dans `troubleshooting.md:29`. Effort recalibré de **S à M** (12 sites d'écriture non gardés, aucun helper, aucun handler dans `cli/index.ts`). Testabilité : moitié repo exécutée, moitié sandbox **bloquée** (WSL2 vide, `sudo` exige un mot de passe). Verdict passé au feu de 2 réfutateurs, qui ont invalidé ma preuve documentaire et remplacé mon périmètre. |
