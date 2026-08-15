# C07 — Distribution : plugin Claude Code, marketplace et bundles `.mcpb`

> **Fiche de veille.** Les sections 1 à 5 sont remplies par la veille.
> Les sections 6.2 à 6.4 et 7 sont remplies **pendant le challenge** (session dédiée).

| Champ | Valeur |
|---|---|
| **ID** | `plugin-marketplace-mcpb` |
| **Surface** | claude-code · agent-sdk · ecosystem |
| **Statut** | GA pour les plugins, marketplaces et MCPB · **research preview** pour les channels (le champ `channels` du manifeste en dépend) |
| **Disponible depuis** | Claude Code : `claude plugin validate` v2.1.221 · source `archive` v2.1.224 · source `command` v2.1.229 · marketplaces GitLab v2.1.232. Agent SDK TS : `options.plugins` 0.1.27 · `reloadPlugins()` 0.2.85 · `skipMcpDiscovery` 0.3.172 · `source: 'archive'` 0.3.224. MCPB : renommé depuis DXT, CLI `dxt` → `mcpb` |
| **Tier** | T1-incontournable |
| **Nature** | opportunity |
| **Effort estimé** | M |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — PoC plugin local OK, `.mcpb` et allowlist Anthropic hors portée |
| **Statut du challenge** | ⬜ à faire |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- **Statut** : « GA » sans nuance était trompeur. Plugins, marketplaces et MCPB sont GA ; les
  **channels sont explicitement en research preview** (`channels-reference` : « Channels are in
  research preview. Team and Enterprise organizations must explicitly enable them »). Or le
  bénéfice n°1 de la fiche repose entièrement sur le champ `channels`.
- **Schéma de `channels` tranché** (c'était le `(à vérifier)` principal) : c'est un **tableau**,
  pas un objet. Chaque entrée a `server` (requis, doit matcher une clé de `mcpServers`) et
  `userConfig` (optionnel, même schéma que le `userConfig` de premier niveau). Exemple corrigé
  dans le §2.
- **Sources de plugin dans `marketplace.json`** : la liste de la fiche (`git · github · gitlab ·
  archive · command`) était fausse. La liste réelle est : chemin relatif (`"./my-plugin"`),
  `github` (`repo`, `ref?`, `sha?`), `url` (URL git), `git-subdir`, `npm`, `archive`
  (`url`, `sha256?`), `command` (`command`, `timeout?`, `mode?`). GitLab est un **hébergement**
  de marketplace, pas un type de source.
- **`strictPluginOnlyCustomization`** : ce n'est pas une valeur scalaire `"mcp"` mais une **liste**
  dans laquelle on met `mcp` (doc `managed-mcp` : « `strictPluginOnlyCustomization` with `mcp` in
  the list »). L'existence du réglage et de son effet « servers can only come from plugins » est
  confirmée.
- **`allowedChannelPlugins`** : forme d'entrée précisée — `[{ "marketplace": "...", "plugin":
  "..." }]`, managed settings uniquement, « Replaces the default Anthropic allowlist when set.
  Undefined = fall back to the default, empty array = block all channel plugins ».
- **Alias `additionalMarketplaces` / `allowedMarketplaces`** : introuvables dans la doc →
  marqués `(non vérifiable)`.
- **`userConfig`** : champs d'une option précisés (`type`, `title`, `description` requis ;
  `sensitive`, `required`, `default`, `multiple`, `min`/`max` optionnels).
- **Variable manquante** : `${CLAUDE_PROJECT_DIR}` est la troisième variable exposée aux plugins,
  absente de la fiche.
- **`cli/init.ts`** : la plage `221-292` commence en fait l. **220** (`if (opts.writeMcpConfig)`),
  le bloc `--write-claude-md` l. **253** et le sentinel l. **259**. Corrigé.
- **`channels`/`plugin.json` ne suffit pas** : la doc dit textuellement « A channel published to
  your own marketplace still needs `--dangerously-load-development-channels`, since it isn't on
  the approved allowlist ». Fait ajouté au §2 — la fiche l'anticipait au §6.5, il est maintenant
  sourcé.

**Vérifications sans correction (§5, tous les fichiers ouverts) :** `cli/channel.ts` l. 29-33 ✅
(le commentaire y est bien) · `README.md` l. 106-121 ✅ (section à 106, note « research preview »
à 119) · `examples/channels-quickstart/.mcp.json.sample` ✅ (les deux entrées, telles que citées) ·
`cli/init.ts` l. 96-110 et l. 306 ✅ · `cli/uninstall.ts` l. 14/18 et 47/85-100 ✅ ·
`cli/config.ts` l. 15-27 ✅ (`data_dir` l. 18, `getConfigDir()` l. 25-27) · `cli/doctor.ts` ✅ ·
`package.json` l. 38-47 / 71 / 100-114 / 128-129 (`node >= 22`) ✅, `version` l. 3 = `2.0.1` ·
`README.md` l. 92 « ~292 MB » ✅ · `src/database.ts` l. 337 `require("better-sqlite3")` ✅ ·
`src/server-setup.ts` l. 242-247 (six `register*Tools`) ✅ ·
`.github/workflows/release-binaries.yml` ✅ (macos-14/macos-15/ubuntu-latest, `--external
tree-sitter*`, aucune cible Windows). Tous les autres fichiers cités existent.

**Marqueurs `(à vérifier)` restants :** 2 sur 4.
Tranchés : le schéma de `channels` ; le `manifest.json` MCPB (documenté dans `MANIFEST.md` du repo
`modelcontextprotocol/mcpb`, confirmé par son README — non recopié ici).
Restants : les alias `additionalMarketplaces` / `allowedMarketplaces` `(non vérifiable — absents
de la doc settings)` ; le mode « seed » (décrit par la doc marketplaces, mais son statut GA n'est
pas affirmé) `(à vérifier)`.

**Testabilité :** ⚠️ partielle
Testable ici et maintenant : écrire `.claude-plugin/plugin.json` + `marketplace.json`, lancer
`claude plugin validate`, `/plugin marketplace add <chemin local>`, installer, et vérifier que
`coordinator` + `coordinator-channel` apparaissent sans `.mcp.json` ; lire `${CLAUDE_PLUGIN_DATA}`
sur Windows ; relancer sans `--dangerously-load-development-channels` et coller l'erreur.
Non testable ici : l'inscription à l'allowlist Anthropic (`claude-plugins-official`, curation
Anthropic), et l'installation en un clic d'un `.mcpb` (exige Claude pour Windows/macOS, une app
distincte de Claude Code). `mcpb init`/`mcpb pack` restent exécutables — seule la vérification de
l'install est bloquée.

## 1. Ce que c'est

Deux vecteurs de distribution distincts, tous deux GA, tous deux absents du projet aujourd'hui.

**Le plugin Claude Code.** Un répertoire contenant un manifeste `.claude-plugin/plugin.json` qui
déclare d'un bloc des serveurs MCP (`mcpServers`), des hooks, des skills, des commandes, des
subagents, des workflows, des serveurs LSP, des monitors expérimentaux — et un champ `channels`,
documenté comme « Message channel declarations binding to MCP servers ». C'est le chemin officiel
pour distribuer un channel. Le plugin s'installe par `/plugin install <plugin>@<marketplace>`, le
marketplace étant un `marketplace.json` hébergé sur git/GitHub/GitLab, sur une URL, dans une
archive zip (`source: "archive"`, HTTPS, sans git, avec SHA256 optionnel) ou produit par une
commande locale ré-résolue à chaque session (`source: "command"`). Deux variables sont exposées au
plugin : `${CLAUDE_PLUGIN_ROOT}` (répertoire d'installation) et `${CLAUDE_PLUGIN_DATA}`
(`~/.claude/plugins/data/{id}/`, persistant à travers les mises à jour). Le champ `userConfig`
demande des valeurs à l'activation et les expose aux hooks sous `CLAUDE_PLUGIN_OPTION_<KEY>`.

**Les MCP Bundles (`.mcpb`).** Une archive zip contenant un serveur MCP local et un
`manifest.json`, installable en un clic dans Claude pour macOS et Windows — conceptuellement une
extension de navigateur. La doc MCP officielle désigne MCPB comme le chemin quand le serveur doit
toucher la machine de l'utilisateur : lire des fichiers locaux, piloter des applications desktop,
ou parler à des services localhost. Node.js est le runtime recommandé parce qu'il est déjà embarqué
dans Claude Desktop. Deux commandes : `mcpb init` et `mcpb pack`.

Le point qui concerne directement le projet : côté entreprise, `strictPluginOnlyCustomization`
avec la valeur `"mcp"` force les serveurs MCP à ne venir que de plugins, et `allowedChannelPlugins`
est la seule allowlist d'org capable d'autoriser un channel. Sa valeur par défaut est le
marketplace officiel `anthropics/claude-plugins-official`, le seul que Claude Code enregistre de
lui-même.

## 2. Surface d'API exacte

```
# Manifeste .claude-plugin/plugin.json
channels                      # ARRAY (vérifié) — « lets a plugin declare one or more message
                              # channels that inject content into the conversation. Each channel
                              # binds to an MCP server that the plugin provides »
                              # entrée : { server: <clé de mcpServers>, userConfig?: {...} }
mcpServers                    # chemin(s) ou config inline
hooks                         # chemin ou config inline, sinon hooks/hooks.json
skills, commands, agents, workflows, outputStyles, lspServers
experimental.themes, experimental.monitors
userConfig                    # valeurs demandées à l'activation
                              # par option : type, title, description (requis) ;
                              # sensitive, required, default, multiple, min, max (optionnels)
dependencies                  # contraintes semver entre plugins
defaultEnabled
+ métadonnées : $schema, name (requis), displayName, version, description, author,
  homepage, repository, license, keywords, metadata

# Variables
${CLAUDE_PLUGIN_ROOT}         # répertoire d'installation
${CLAUDE_PLUGIN_DATA}         # ~/.claude/plugins/data/{id}/ — survit aux mises à jour
${CLAUDE_PROJECT_DIR}         # racine du projet
${CLAUDE_PLUGIN_OPTION_<KEY>} # userConfig exposé (KEY en majuscules)

# Marketplace + CLI
marketplace.json
/plugin marketplace add · /plugin install <plugin>@<marketplace>
claude plugin validate
sources de plugin (vérifié) :
  "./chemin-relatif"          # répertoire local dans le repo du marketplace
  github    { repo, ref?, sha? }
  url       { url, ref?, sha? }          # URL git
  git-subdir{ url, path, ref?, sha? }
  npm       { package, version?, registry? }
  archive   { url, sha256? }             # HTTPS, ≤ 256 MiB — Claude Code ≥ v2.1.224
  command   { command, timeout?, mode? } # ré-exécuté une fois par session — ≥ v2.1.229
  (GitLab est un hébergement de marketplace, pas un type de source)
anthropics/claude-plugins-official

# Réglages d'organisation
extraKnownMarketplaces        # headers supportés pour les sources URL, envoyés
                              # uniquement sur les archives de même origine
                              # (scheme+host+port), abandonnés sur redirection hors origine
strictKnownMarketplaces       # accepte des wildcards propriétaire : "owner/*"
                              # alias additionalMarketplaces / allowedMarketplaces
                              # (non vérifiable — absents de la doc settings)
disableCommandPluginSources   # managed settings — bloque les sources "command"
strictPluginOnlyCustomization # LISTE ; y mettre "mcp" pour « servers can only come
                              # from plugins » (et non la valeur scalaire "mcp")
allowedChannelPlugins         # managed settings ; [{ marketplace, plugin }]
                              # non défini = allowlist Anthropic par défaut ; [] = tout bloqué
enabledPlugins                # { "plugin@marketplace": true }
allowedMcpServers / deniedMcpServers / allowManagedMcpServersOnly / managed-mcp.json

# Agent SDK TypeScript (côté hôte)
options.plugins: SdkPluginConfig[]
reloadPlugins()               # renvoie commandes / agents / statut MCP rafraîchis
skipMcpDiscovery: true        # par plugin — l'hôte gère lui-même les connexions MCP

# MCPB
mcpb init · mcpb pack · archive .mcpb (zip) · manifest.json
hôtes : Claude pour macOS et Windows
skill build-mcpb — plugin anthropics/claude-plugins-official/plugins/mcp-server-dev

# Channel (rappel channels-reference)
capabilities.experimental['claude/channel'] = {}            # requis, fait de ce serveur un channel
capabilities.experimental['claude/channel/permission'] = {} # relais de permissions (Phase 3)
notifications/claude/channel                                # params : content, meta
--channels plugin:<nom>@<marketplace>                       # activation par session
--dangerously-load-development-channels server:<nom> | plugin:<nom>@<marketplace>
# « A channel published to your own marketplace still needs
#   --dangerously-load-development-channels, since it isn't on the approved allowlist. »
```

Forme visée pour un `plugin.json` mcp-coordinator (schéma de `channels` **vérifié** contre
`plugins-reference` le 2026-08-14) :

```json
{
  "name": "mcp-coordinator",
  "mcpServers": {
    "coordinator": { "type": "http", "url": "${CLAUDE_PLUGIN_OPTION_COORDINATOR_URL}" },
    "coordinator-channel": { "command": "mcp-coordinator", "args": ["channel"] }
  },
  "channels": [
    { "server": "coordinator-channel" }
  ],
  "userConfig": {
    "coordinator_url": {
      "type": "string",
      "title": "Coordinator URL",
      "description": "URL du daemon mcp-coordinator",
      "default": "http://localhost:3100/mcp"
    }
  }
}
```

Points à ne pas présumer :

- Le schéma du `manifest.json` d'un `.mcpb` n'est pas dans le bundle ; il est bien défini dans le
  fichier `MANIFEST.md` du repo `modelcontextprotocol/mcpb` (confirmé par son README :
  « the complete bundle manifest structure and field definitions »). Non recopié ici.
- **Corrigé le 2026-08-14** : la distinction n'est pas « git vs archive » mais **marketplace vs
  plugin**. Une *source de marketplace* (où trouver le `marketplace.json`) supporte `ref`
  (branche/tag) mais **pas** `sha`. Une *source de plugin* (dans `marketplace.json`) supporte
  `ref` **et** `sha` (commit exact). La source `archive` accepte en plus un `sha256`, qui sert
  aussi de version quand aucune n'est déclarée. Trois mécanismes, à ne pas confondre.
- Le mode « seed » (plugins pré-peuplés en lecture seule pour les conteneurs, via
  `$CLAUDE_CODE_PLUGIN_SEED_DIR/marketplaces/<name>/`, où `/plugin marketplace remove` et
  `update` échouent) est confirmé par `plugin-marketplaces` ; son statut GA n'y est pas
  affirmé. **(à vérifier)**

**Divergences entre chercheurs, signalées telles quelles.** Un chercheur donne `since: unknown`
pour la distribution par marketplace, les deux autres donnent des versions précises. Surtout :
`source: 'archive'` est daté v2.1.224 côté Claude Code et 0.3.224 côté Agent SDK TypeScript —
ce sont **deux flux de version différents**, pas une contradiction, mais la ressemblance des
numéros invite à l'erreur. Aucune source ne date le champ `channels` lui-même.

## 3. Sources

- https://code.claude.com/docs/en/plugins-reference.md
- https://code.claude.com/docs/en/plugin-marketplaces
- https://code.claude.com/docs/en/channels-reference
- https://code.claude.com/docs/en/channels.md
- https://code.claude.com/docs/en/workflows.md
- https://code.claude.com/docs/en/managed-mcp
- https://code.claude.com/docs/en/agent-sdk/overview.md
- https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md
- https://raw.githubusercontent.com/anthropics/claude-agent-sdk-typescript/main/CHANGELOG.md
- https://github.com/modelcontextprotocol/mcpb
- https://modelcontextprotocol.io/docs/2026-07-28/develop/build-with-agent-skills.md
- https://github.com/anthropics/claude-plugins-official/tree/main/plugins/mcp-server-dev

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :**

1. **C'est la sortie du `--dangerously-load-development-channels`, et il n'y en a pas d'autre.**
   Le code le dit déjà : `cli/channel.ts` l. 29-33 documente que « until this plugin is on
   Anthropic's allowlist, users must launch Claude Code with
   `--dangerously-load-development-channels` ». Le README l. 106-121 expose cette contrainte à
   l'utilisateur final. Le travail de Phase 1 + Phase 2 des channels (491 lignes, `post_to_thread`
   inclus) est donc livré derrière un drapeau qui contient le mot « dangerously ». Or
   `allowedChannelPlugins` ne sait autoriser qu'un **plugin** : sans manifeste `plugin.json`
   déclarant `channels`, il n'existe aucun chemin — ni communautaire ni entreprise — pour lever
   le drapeau.

2. **L'installation passe de quatre étapes à une.** Aujourd'hui : `npm install -g mcp-coordinator`,
   `mcp-coordinator init`, copier-coller le snippet `.mcp.json` (ou `--write-mcp-config`), puis
   éventuellement `--write-claude-md`. Le fichier `examples/channels-quickstart/.mcp.json.sample`
   montre les deux entrées à déclarer à la main (`coordinator` en HTTP, `coordinator-channel` en
   stdio). Un `plugin.json` déclare exactement ces deux entrées. Le code qui pourrait maigrir est
   identifié : `cli/init.ts` l. 100-107 et l. 221-292 (`--write-mcp-config`, `--write-claude-md`,
   fusion non destructive, sentinel de section) et son miroir `cli/uninstall.ts` l. 13-25 et
   l. 45-100. Le `--url` de `init` (l. 96-99) devient un champ `userConfig`.

3. **`${CLAUDE_PLUGIN_DATA}` est l'emplacement propre pour l'état local.** `cli/config.ts` l. 18
   et l. 26 codent en dur `~/.mcp-coordinator/` et `~/.mcp-coordinator/data`. Un répertoire fourni
   par l'hôte, garanti persistant à travers les mises à jour du plugin, retire au projet la charge
   de choisir un emplacement cross-platform — un point sensible pour un mainteneur sous Windows.

4. **MCPB ouvre une surface que le projet n'a pas du tout.** Aujourd'hui : npm, Docker/GHCR, et
   des binaires `bun --compile` pour darwin-arm64, darwin-x64 et linux-x64
   (`.github/workflows/release-binaries.yml`) — **aucun binaire Windows**. Un `.mcpb` cible
   précisément macOS et Windows, avec un runtime Node embarqué par l'hôte, ce qui supprime le
   prérequis « Node ≥ 22 » (`package.json` l. 128-130) pour un utilisateur non développeur.

**Risque si on ne fait rien :**

Réel, et pas seulement positionnel. `strictPluginOnlyCustomization: "mcp"` force les serveurs MCP
à ne venir que de plugins : dans une organisation qui active ce réglage, mcp-coordinator devient
**non installable**, quel que soit son mérite technique — il n'existe sous aucune forme de plugin.
Le même verrou s'applique aux channels via `allowedChannelPlugins`. Le projet a construit une
fonctionnalité de push temps réel qu'aucun utilisateur en entreprise ne peut activer.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `cli/channel.ts` (l. 29-33) | Le commentaire d'en-tête énonce déjà le blocage : allowlist Anthropic ou `--dangerously-load-development-channels`. C'est la cible du champ `channels` du manifeste. Le serveur stdio existe et fonctionne — seul le vecteur de déclaration manque. |
| `examples/channels-quickstart/.mcp.json.sample` | Contient exactement les deux entrées que `mcpServers` devrait porter : `coordinator` (`type: "http"`, `http://localhost:3100/mcp`) et `coordinator-channel` (`command: "mcp-coordinator"`, `args: ["channel"]`). Point de départ littéral du `plugin.json`. |
| `README.md` (l. 106-121) | Section « Real-time push via Claude Code Channels (research preview) » : la ligne `claude --dangerously-load-development-channels server:mcp-coordinator-channel` et la mention « Claude Code v2.1.80+ » sont à réécrire si le plugin passe. |
| `cli/init.ts` (l. 96-110, 220-292) | `--url` (l. 96-99), `--write-mcp-config` (l. 100-103), `--write-claude-md` (l. 104-107), `--print-only` (l. 108-112). C'est le code que le plugin rend partiellement redondant. La fusion non destructive de `.mcp.json` (l. 220-251) et le sentinel CLAUDE.md (l. 253-292, `SENTINEL` défini l. 259) disparaîtraient. |
| `cli/init.ts` (l. 306) | « Connect any MCP client (Claude Code, Cursor, Cline, ...) » — la promesse d'agnosticisme, à confronter à un vecteur exclusif Claude Code. |
| `cli/uninstall.ts` (l. 13-25, 45-100) | `--mcp-config` et `--claude-md` sont le miroir de `init`. Si l'install passe par `/plugin`, la désinstallation aussi ; les deux chemins devront coexister le temps de la transition. |
| `cli/config.ts` (l. 15-27) | `DEFAULT_CONFIG.server.data_dir = ~/.mcp-coordinator/data`, `getConfigDir()` codé en dur. À confronter à `${CLAUDE_PLUGIN_DATA}` : soit `loadConfig()` lit la variable, soit les deux emplacements divergent. |
| `cli/doctor.ts` | Checks nommés (`phase2.public_url`, `phase2.sqlite`, `phase2.audit_queue`, `config.json`…). Un check `plugin.installed` / `plugin.version_match` (manifeste vs `package.json`) s'insère dans le même moule — la version du plugin apparaît dans `system/init` et dans la réponse `reload_plugins`. |
| `package.json` (l. 38-47) | `bin: mcp-coordinator → ./dist/cli/index.js` et `files: [dist/src, dist/cli, dashboard, LICENSE, README.md]`. Un `.claude-plugin/plugin.json` versionné devrait entrer dans `files` ; sa `version` doit rester alignée sur la l. 3. |
| `package.json` (l. 68-83, 99-115) | `better-sqlite3` est une dépendance native ; les 14 grammaires tree-sitter (~292 MB, README l. 92) sont en `optionalDependencies`. Facteur dimensionnant pour un zip `.mcpb`. |
| `src/database.ts` (l. 337) | `const Database = require("better-sqlite3")` — chargement d'un module natif. `src/db-adapter.ts` documente le contrat partagé avec `bun:sqlite`. Détermine si `mcpb pack` peut produire une archive portable. |
| `.github/workflows/release-binaries.yml` | Matrice macos-14/arm64, macos-15/x64, ubuntu/x64 ; `bun build --compile` avec `--external tree-sitter*`. Aucune cible Windows, alors que MCPB vise macOS **et** Windows. |
| `.github/workflows/release.yml`, `docker-publish.yml` | Le pipeline enchaîne déjà release-please → npm → Docker → binaires. Publier un `marketplace.json` et/ou un `.mcpb` ajoute un à deux artefacts à garder en phase à chaque tag. |
| `src/server-setup.ts` (l. 242-247) | Les six `register*Tools` exposent 26 outils MCP. Le manifeste déclare le **serveur**, pas les outils : aucun impact sur le découpage, contrairement aux fiches de la série A. |
| `src/tools/*.ts` | Non modifiés par ce vecteur. À vérifier seulement si `userConfig` doit remplacer une variable d'environnement lue au démarrage. |
| `docs/ARCHITECTURE.md`, `docs/operating-modes.md`, `docs/onboarding-self-host.md`, `examples/channels-quickstart/README.md`, `docs/index.html` | Toute la procédure d'installation change. `docs/index.html` porte plusieurs langues inline — une chaîne = plusieurs éditions. |
| `sdk/src/client.ts` | Non concerné. `options.plugins` / `reloadPlugins()` sont l'API de l'**hôte** Agent SDK, pas celle d'un client MCP. Pertinent uniquement si le projet publie un jour son propre hôte. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Le plugin `mcp-coordinator` doit-il embarquer le daemon complet (broker MQTT + HTTP + SQLite,
> lancé depuis `${CLAUDE_PLUGIN_ROOT}` avec `${CLAUDE_PLUGIN_DATA}` comme `data_dir`), ce qui
> donne un coordinateur par poste et casse le modèle « un daemon, N agents » qui fait tout
> l'intérêt du projet — ou se limiter à un plugin *client* qui ne déclare que `channels` et un
> `mcpServers` pointant, via `userConfig`, vers un daemon installé séparément par npm ou Docker ?

### 6.2 Hypothèse

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

<Proposition de la veille — à amender pendant le challenge.>

> ⚠️ Non exécutable ici : l'inscription à l'allowlist Anthropic (`claude-plugins-official`) et
> l'installation en un clic d'un `.mcpb`, qui exige Claude pour Windows/macOS — une application
> distincte de Claude Code. `mcpb init` / `mcpb pack` restent lançables ; seule la vérification
> de l'installation est bloquée.

- [ ] Écrire un `.claude-plugin/plugin.json` minimal (les deux entrées de
      `examples/channels-quickstart/.mcp.json.sample`) + un `marketplace.json`, l'ajouter par
      `/plugin marketplace add` depuis un chemin local, installer, et vérifier que le serveur
      `coordinator` apparaît **sans** aucun `.mcp.json` dans le projet. Passer `claude plugin
      validate` sur le manifeste et coller la sortie.
- [ ] Déterminer le schéma réel du champ `channels` (aucune source du bundle ne le donne) : le
      remplir jusqu'à ce que `cli/channel.ts` soit spawné, puis relancer Claude Code **sans**
      `--dangerously-load-development-channels` et noter le message d'erreur exact — c'est lui
      qui dira si l'allowlist Anthropic est vraiment le seul chemin, ou si un plugin installé
      localement suffit.
- [ ] Lire la valeur effective de `${CLAUDE_PLUGIN_DATA}` sur Windows, y pointer
      `config.server.data_dir`, désinstaller/réinstaller le plugin et vérifier que la base SQLite
      survit. Confronter à `cli/config.ts` l. 18.
- [ ] `mcpb init` + `mcpb pack` sur `cli/index.ts`, puis installer le `.mcpb` dans Claude pour
      Windows : vérifier si le prebuild natif `better-sqlite3` (`src/database.ts` l. 337) survit
      au zip, et mesurer la taille de l'archive avec puis sans les grammaires tree-sitter.
- [ ] Mesurer le coût de la double publication : ajouter un job `plugin`/`mcpb` à
      `.github/workflows/release.yml` sur un tag de test et vérifier que la version du manifeste,
      celle de `package.json` l. 3 et celle rapportée par `system/init` coïncident.

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **Faire un plugin ne lève pas le blocage des channels.** C'est le contre-argument central :
  `allowedChannelPlugins` a pour valeur par défaut le marketplace officiel
  `anthropics/claude-plugins-official`, et l'alternative est un réglage d'**administrateur d'org**.
  Un mainteneur solo dont les utilisateurs sont des individus ne contrôle ni l'un ni l'autre. On
  peut donc écrire le manifeste, le publier, et rester exactement au même point :
  `--dangerously-load-development-channels`. Le travail est un prérequis, pas une solution.
- **MCPB ne correspond pas au modèle de déploiement.** Un bundle installe un serveur MCP **local
  et par machine**. mcp-coordinator est un daemon **partagé** : broker MQTT embarqué
  (`src/mqtt-broker.ts`), HTTP + SSE (`src/serve-http.ts`), SQLite unique. N bundles = N
  coordinateurs qui ne coordonnent rien. Le seul candidat crédible à l'empaquetage est le processus
  stdio `mcp-coordinator channel`, qui suppose de toute façon un daemon déjà installé autrement —
  soit le gain « plus besoin de Node » s'évapore.
- **Verrouillage sur Claude Code, contre une promesse écrite.** `cli/init.ts` l. 306 annonce
  « any MCP client (Claude Code, Cursor, Cline, ...) ». Le format plugin est exclusivement Claude
  Code, le `.mcpb` exclusivement Claude Desktop macOS/Windows. Deux canaux à documenter et à
  maintenir dont aucun ne sert un utilisateur de Cursor ou de Cline.
- **Deux artefacts de plus dans un pipeline déjà chaîné.** `release.yml` orchestre release-please →
  npm → Docker → binaires, et les deux derniers correctifs CI du dépôt (commits `a79b60b`,
  `7c5f894`) portent précisément sur ce chaînage. Ajouter un `marketplace.json` à publier et un
  `.mcpb` à empaqueter, versionner et attacher augmente la surface d'un pipeline dont l'historique
  montre qu'il est déjà fragile.
- **Dérive de version silencieuse.** La version du plugin remonte dans `system/init` et dans la
  réponse `reload_plugins`. Si `plugin.json` et `package.json` l. 3 divergent, le diagnostic ment
  à l'utilisateur — un troisième numéro de version à tenir en phase, en plus de npm et de l'image
  GHCR.
- **Le packaging natif n'est pas résolu.** `better-sqlite3` est natif et
  `release-binaries.yml` documente déjà que `bun --compile` échoue à embarquer les prebuilds
  tree-sitter, contournés par `--external`. Un `.mcpb` multi-plateforme se heurte au même mur, en
  pire : il n'y a même pas de cible Windows dans la matrice de build actuelle, alors que Windows
  est la moitié de la cible MCPB.
- **YAGNI.** Aucune demande utilisateur n'est citée dans le bundle. Les utilisateurs actuels
  passent par npm et Docker sans se plaindre du nombre d'étapes ; les deux contributeurs externes
  sont des développeurs pour qui `npm install -g` n'est pas un obstacle. Le pari
  `strictPluginOnlyCustomization: "mcp"` suppose que des organisations activent réellement ce
  réglage — rien dans le bundle ne l'atteste.
- **Le gain en code retiré est plus faible qu'il n'y paraît.** `--write-mcp-config` et
  `--write-claude-md` ne peuvent pas être supprimés : ils servent les clients non-Claude-Code. Le
  plugin **ajoute** un chemin d'installation, il n'en retire aucun. `uninstall`, `doctor` et la
  documentation grossissent tous les trois.

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
| 2026-08-14 | Vérification des faits : schéma `channels` tranché, sources plugin et `strictPluginOnlyCustomization` corrigés, statut nuancé (channels = research preview), §5 vérifié fichier par fichier. |
