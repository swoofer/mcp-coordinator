# A10 — Identité et découverte : `mcpName`, `server.json`, `/server-card`, Inspector en CI

| Champ | Valeur |
|---|---|
| **ID** | `registry-servercard-conformance` |
| **Surface** | mcp-spec · ecosystem |
| **Statut** | **mixte** — MCP Registry : *preview* · Server Cards : *experimental* · Inspector : *GA* · SEP-2484 : *Final* |
| **Disponible depuis** | Registre annoncé 2025-09-08, schéma `server.json` daté 2025-12-11, API `v0.1` en service (réponse vérifiée le 2026-08-14) ; Inspector documenté sous `/docs/2026-07-28/`, requiert Node ≥ 22.19.0 ; SEP-2484 *Final* (créée 2026-03-27) ; SEP-2127 (Server Cards) ouverte le 2026-01-21, dernière activité 2026-08-11, non mergée au 2026-08-14 |
| **Tier** | T1-incontournable |
| **Nature** | opportunity (registre) · integration (Inspector) |
| **Effort estimé** | M (S par brique, 3 briques) |
| **Confiance veille** | medium |
| **Vérification** | CONFIRMED pour l'Inspector et les Server Cards ; PLAUSIBLE pour le registre (une erreur matérielle corrigée : statut « GA » → « preview ») |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ✅ testable — PoC local suffit, aucun accès privilégié requis |
| **Statut du challenge** | ⬜ à faire |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- **§2, sous-commandes `mcp-publisher` — erreur factuelle inversée.** La fiche affirmait « exactement ces 4 sous-commandes : `init | login github | logout | publish` » et la contradiction n°2 tranchait qu'il n'existe **pas** de `validate`. Le `--help` officiel reproduit dans le quickstart du dépôt `modelcontextprotocol/registry` liste **six** commandes : `init`, `login`, `logout`, `publish`, `status`, `validate`. C'est le chercheur qui listait `validate` qui avait raison ; le vérificateur précédent s'est trompé. Bloc et contradiction n°2 réécrits.
- **§2, marqueur `(à vérifier)` sur les invocations du client CLI de l'Inspector — résolu.** La doc `/docs/2026-07-28/tools/inspector/cli.md` documente l'intégralité de la surface (modes, méthodes, flags, codes de sortie). Bloc Inspector remplacé par les faits établis.
- **§2, `login dns` / `login http` — précisés** avec leurs flags réels (`--domain`, `--private-key`, `--algorithm`, backends `google-kms` / `azure-key-vault`) et les deux algorithmes acceptés (`ed25519`, `ecdsap384`).
- **§2, type de média `application/mcp-server-card+json` et `/.well-known/ai-catalog.json` — source rectifiée.** Ces deux éléments ne figurent **pas** dans le README de `experimental-ext-server-card` ; ils viennent du dépôt tiers `Agent-Card/ai-catalog`, que le README ne fait que référencer par lien. Mention ajoutée.
- **En-tête, statut de SEP-2484 :** *GA* → *Final* (statut formel du SEP, créé 2026-03-27). L'existence d'un dépôt de conformance exécutable (`modelcontextprotocol/conformance`, outil `npx @modelcontextprotocol/conformance`) a été ajoutée en §2 — elle change la testabilité.
- **§5, numéros de ligne :** `src/server-setup.ts:225-234` → `226-235` (le champ `name` est en **233**, pas 232) ; `cli/doctor.ts:58-100` → `59-102` (la fonction `mcpInitialize` court de 59 à 102 ; `protocolVersion: "2024-11-05"` est en 66, comme le dit déjà §4) ; `audit/09-protocole-mcp.md:224-233` → `224-234`.
- **§5, chaîne de routage `src/serve-http.ts:667-740` :** la plage est exacte, mais l'énumération omettait deux branches réellement présentes — `/metrics/auth` (ligne 719, gaté sur `ctx.phase2Bootstrap`) et `url.startsWith("/api/auth/")` (ligne 734). Ajoutées, avec le numéro de ligne de chaque branche.
- **§4, `src/server-setup.ts:232` → `:233`** (même erreur d'un cran que §5).
- *Non corrigé, signalé :* §6.5 cite elle aussi `src/server-setup.ts:232` au lieu de 233. §6.5 est une section protégée, elle n'a pas été touchée.

**Passe du 2026-08-14, second tour.** La passe précédente avait rédigé cette section §0 mais n'avait appliqué qu'une partie des corrections qu'elle annonçait : le bloc `mcp-publisher` de §2 était bien à six sous-commandes, mais la **contradiction n°2** de §2 affirmait toujours l'inverse (« pas de `validate` »), et **aucune** des corrections de numéros de ligne de §5 n'était en place. Toutes ont été appliquées et revérifiées fichier par fichier ce jour.

**Faits vérifiés et confirmés sans changement :** statut *preview* du registre (bandeau du quickstart officiel, mot pour mot) ; API `v0.1` en service — `GET /v0.1/servers?search=mcp-coordinator` renvoie `{"servers":[],"metadata":{"count":0}}` le 2026-08-14, donc **le nom n'est pas publié et reste libre** ; `$schema` `2025-12-11` ; format `v=MCPv1; k=ed25519; p=PUBLIC_KEY` ; `mcpName` npm et ligne `mcp-name:` README pour PyPI/NuGet ; `/server-card` réservé, `$schema` en `/schemas/v1/<name>.schema.json`, interfaces `ServerCard` / `Remote` / `Icon` / `Repository` conformes champ pour champ à `schema.ts` ; SEP-2127 ouverte, non mergée ; extension explicitement « not an accepted or official MCP extension » ; côté dépôt : pas de `server.json`, `mcpName` en `package.json:4`, `version: 2.0.1`, 6 workflows, aucune occurrence du mot « inspector », `test.yml` à 3 jobs (matrice 22/24 + `sdk-test` + `build-no-native`), `pnpm publish` en `release.yml:102`, `docs/openapi.yaml:901`, `docs/maintainer-notes.md:108-116`, `src/discovery.ts` 51 lignes.

**Marqueurs `(à vérifier)` restants :** aucun.

**Testabilité :** ✅ testable

Tout le §6.3 est exécutable sur ce poste, sans credential Anthropic, sans header beta, sans allowlist d'org. La mesure décisive — `npx @modelcontextprotocol/inspector --cli http://localhost:<port>/mcp --transport http --method tools/list --format json` contre `pnpm dev`, puis la même chose en stdio, sur au moins deux ères de protocole — tourne en local avec le Node 22 du projet (l'Inspector exige ≥ 22.19.0). La case 1 est déjà répondue par la requête ci-dessus. La case 2 se règle hors ligne avec `mcp-publisher init` puis `mcp-publisher validate` (binaire Windows fourni en release GitHub), sans jamais publier. Seule la case 5 (chronométrage du step dans GitHub Actions) ne peut être qu'approximée localement — le temps d'un run Inspector local en donne l'ordre de grandeur, la valeur exacte demande un push sur une branche.

---

## 1. Ce que c'est

Trois briques distinctes qui répondent à la même question — « comment un client sait-il que ce serveur MCP est bien celui qu'il prétend être, et se comporte-t-il correctement ? » — à trois niveaux de maturité très différents.

**Le MCP Registry** (`registry.modelcontextprotocol.io`) est un annuaire officiel qui n'héberge **que des métadonnées**, jamais du code : le paquet doit déjà exister sur npm/PyPI/NuGet/OCI. L'identité se prouve par un aller-retour : une propriété `mcpName` dans le `package.json` npm dont la valeur doit être **exactement** le champ `name` du `server.json` publié. Trois modes d'authentification de namespace : GitHub (impose le préfixe `io.github.<user>/`), DNS TXT, ou fichier HTTP `/.well-known/mcp-registry-auth` sur un domaine possédé. Le registre ne fait **aucun scan de sécurité** (délégué aux registres de paquets et aux agrégateurs aval) et sa modération se limite au retrait d'illégal/malware/spam/serveurs cassés.

**Les Server Cards** (dépôt `modelcontextprotocol/experimental-ext-server-card`, SEP-2127) sont un document JSON statique décrivant un serveur MCP **distant** assez pour qu'un client s'y connecte sans se connecter d'abord : identité, icônes, et surtout `remotes[]` (URL, en-têtes, versions de protocole supportées). Emplacement réservé recommandé : `GET <streamable-http-url>/server-card`. Les cartes omettent volontairement la liste des outils (listables au runtime) et les métadonnées d'installation locale, qui restent du ressort du `server.json`.

**L'Inspector** est l'outillage de validation officiel : trois clients (web, CLI scriptable, TUI) plus une page « Protocol Eras » consacrée au fait qu'un serveur doit se comporter correctement sur **plusieurs révisions de protocole simultanément**. En parallèle, SEP-2484 impose désormais des tests de conformance pour qu'un SEP atteigne le statut *Final* — une suite de conformance de référence se constitue donc côté MCP et devient l'étalon de « serveur conforme ».

## 2. Surface d'API exacte

```
# Registre — identité
package.json : "mcpName": "<doit égaler server.json.name>"
README (PyPI/NuGet uniquement) : ligne "mcp-name: <server-name>"

# server.json
$schema   https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json
name, description, version (synchronisée avec la version npm)
repository { url, source }
packages[] { registryType, identifier, version, transport { type }, environmentVariables[] }

# Namespaces / auth
io.github.<user>/<server>   ou   io.github.<org>/<server>
   mcp-publisher login github                       (device flow ; org => rôle Owner requis)
com.<domaine-inversé>/*     via DNS TXT à l'apex du domaine (PAS sous un sélecteur)
   mcp-publisher login dns  --domain "$D" --private-key "$K" [--algorithm ecdsap384]
   mcp-publisher login dns  google-kms|azure-key-vault --domain="$D" ...
com.<domaine-inversé>/*     via fichier HTTP
   mcp-publisher login http --domain "$D" --private-key "$K" [--algorithm ecdsap384]
   https://<domaine>/.well-known/mcp-registry-auth
   contenu, identique au TXT : "v=MCPv1; k=ed25519; p=$PUBLIC_KEY"
                            ou "v=MCPv1; k=ecdsap384; p=$PUBLIC_KEY"

# CLI — --help officiel : SIX sous-commandes (vérifié 2026-08-14)
mcp-publisher init | login | logout | publish | status | validate
   init      Create a server.json file template
   login     Authenticate with the registry
   logout    Clear saved authentication
   publish   Publish server.json to the registry
   status    Update the status of a server version
   validate  Validate server.json without publishing      <- existe bel et bien

# Vérification
GET https://registry.modelcontextprotocol.io/v0.1/servers?search=<nom>
   réponse vide observée le 2026-08-14 pour search=mcp-coordinator :
   {"servers":[],"metadata":{"count":0}}
Spec sous-registres : docs/reference/api/openapi.yaml

# Server Cards
GET <streamable-http-url>/server-card        (emplacement réservé recommandé)
$schema MUST = https://static.modelcontextprotocol.io/schemas/v1/<name>.schema.json
type ServerCard : name, version, description, title?, websiteUrl?,
  repository? { url, source, subfolder?, id? },
  icons? Icon[] { src, mimeType?, sizes?, theme? },
  remotes? Remote[] { type: "streamable-http"|"sse", url, headers? KeyValueInput[],
                      variables?, supportedProtocolVersions? },
  _meta?
(champs vérifiés un à un contre schema.ts du dépôt, 2026-08-14)

# Découverte par domaine — ATTENTION à la source
# Ni le type de média ni ai-catalog.json ne sont définis par le dépôt
# experimental-ext-server-card : il se contente de lier le dépôt TIERS
# Agent-Card/ai-catalog (Linux Foundation, adoption MCP/A2A non votée).
GET /.well-known/ai-catalog.json                          (spec Agent-Card)
  entrées { identifier, type, url | data }
  type d'artefact cité : "application/mcp-server-card+json"
  URN : préfixe "urn:air:" ; le détail du format est encore en cours
        de définition côté ai-catalog (non figé)

# Inspector — paquet unique @modelcontextprotocol/inspector, Node >= 22.19.0
# Trois clients derrière un seul binaire (mcp-inspector) :
npx @modelcontextprotocol/inspector              # web (défaut)
npx @modelcontextprotocol/inspector --cli        # scriptable, CI
npx @modelcontextprotocol/inspector --tui        # terminal
# Le launcher ne possède QUE --web/--cli/--tui et -h/--help ; tout le reste
# (--server-url, --transport, --config, --catalog, --method, OAuth) appartient
# au client. `mcp-inspector --cli --help` sort la référence complète du CLI.

# Client CLI — surface exacte (docs/2026-07-28/tools/inspector/cli.md)
sélection du serveur : commande positionnelle (stdio)
                     | --server-url <url> --transport http|sse
                     | --config <fichier> --server <nom>   (ou --catalog)
--method : initialize | tools/list | tools/call | resources/list
         | resources/read | resources/templates/list | prompts/list
         | prompts/get | logging/setLevel | servers/list | servers/show
compagnons : --tool-name, --tool-arg k=v (JSON-coercé), --tool-args-json
             (verbatim, exclusif), --uri, --prompt-name, --prompt-args,
             --log-level, --header, --app-info
sortie : --format text (défaut) | json
auth CI : --stored-auth-only (le flag que veut la CI) | --use-stored-auth
codes de sortie : 0 ok · 1 usage/inattendu · 2 pas de MCP App · 3 auth requise
                  · 4 serveur injoignable · 5 erreur d'outil / outil absent
                  (+ une ligne JSON unique sur stderr : {"error":{code,message,...}})
pages : Web, CLI, TUI, Configuration and flags, Authorization,
        Protocol eras (legacy vs modern 2026-07-28), Recipes

# SEP-2484 — statut Final, créé 2026-03-27, type Process
Exige, pour tout SEP Standards Track à comportement observable passant
Accepted -> Final : un scénario de conformance mergé dans le dépôt
modelcontextprotocol/conformance + un fichier de traçabilité sep-NNNN.yaml
mappant chaque MUST/SHOULD à un check ou à une exclusion documentée.
Outillage exécutable existant : npx @modelcontextprotocol/conformance
                                (sous-commande new-scenario --sep <n>)
Seuils SEP-1730 : Tier 1 = 100 % de la suite, Tier 2 = 80 %.
```

**Contradictions entre chercheurs, signalées explicitement :**

1. **Statut du registre.** Un chercheur l'annonce en `research-preview`, un autre en `GA`. Le vérificateur tranche : l'encadré permanent du quickstart officiel annonce *breaking changes ou data resets possibles avant la GA*. L'API `v0.1` répond bien (vérifiée en direct le 2026-08-14) mais le service **n'est pas GA**. Retenir : **preview**.
2. **Sous-commande `validate`.** Un chercheur liste `login | validate | publish`, un autre affirme qu'elle n'existe pas. Tranché le 2026-08-14 : le `--help` officiel reproduit dans le quickstart du dépôt `modelcontextprotocol/registry` liste **six** commandes — `init | login | logout | publish | status | validate`. `validate` (« Validate server.json without publishing ») **existe bel et bien** ; c'est le chercheur qui la listait qui avait raison.
3. **Découverte générique.** La mention d'un `.well-known/mcp.json` n'est soutenue par aucune des sources du bundle et a été retirée. De même, des blogs tiers annoncent un chemin `/.well-known/mcp/server-card.json` et un support livré dans Claude Desktop/Cursor « MCP v2.1, avril 2026 » : **non confirmé**, le dépôt officiel réserve `/server-card` et la SEP est encore ouverte.
4. **Bootstrap automatique par Server Card.** Un chercheur présente `/server-card` comme la brique de bootstrap manquante de `mcp-coordinator init`. Le vérificateur corrige : la découverte automatique passe par un AI Catalog publié sur un **domaine** ; pour un daemon sur `localhost`, **aucun mécanisme de découverte n'est spécifié** — `/server-card` reste une convention vers laquelle un client doit être pointé manuellement.

## 3. Sources

- https://modelcontextprotocol.io/registry/about
- https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx
- https://raw.githubusercontent.com/modelcontextprotocol/registry/main/docs/modelcontextprotocol-io/quickstart.mdx
- https://modelcontextprotocol.io/registry/moderation-policy
- https://raw.githubusercontent.com/modelcontextprotocol/experimental-ext-server-card/main/README.md
- https://modelcontextprotocol.io/docs/extensions/overview
- https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector.md
- https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector/protocol-eras.md
- https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector/cli.md
- https://modelcontextprotocol.io/seps/2484-conformance-tests-required-for-final-seps.md
- https://modelcontextprotocol.io/community/working-groups/inspector-v2.md

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu.**

Le dépôt est déjà **à mi-chemin, dans un état incohérent** : `package.json:4` déclare `"mcpName": "io.github.swoofer/mcp-coordinator"` et `src/server-setup.ts:233` aligne `serverInfo.name` sur cette même valeur — mais il n'existe **aucun `server.json`** à la racine et **aucun step `mcp-publisher`** dans les six workflows CI. C'est exactement le constat `protocole-mcp-13` de l'audit (`audit/09-protocole-mcp.md:224`), et `docs/maintainer-notes.md:108-116` acte la décision « publication différée ». La conséquence : `mcpName` promet aujourd'hui une publication qui n'existe pas. Deux sorties propres, une seule à choisir — publier (ajouter `server.json` + un step dans `release.yml`, effort S, le paquet npm et l'image GHCR existent déjà) ou retirer `mcpName`. L'état actuel n'est ni l'un ni l'autre.

Côté Inspector, le gain est plus tangible et indépendant du registre. `cli/doctor.ts:66` envoie un `initialize` avec `protocolVersion: "2024-11-05"` **codé en dur**, et c'est la seule sonde protocolaire du projet ; les tests d'intégration utilisent chacun une révision différente (`2025-03-26` dans `tests/integration/mcp-session-cors-expose.test.ts:58`, `LATEST_PROTOCOL_VERSION` dans `tests/integration/stdio-log-purity.test.ts:116`). Aucune occurrence du mot « inspector » dans le dépôt. Le client CLI de l'Inspector, branché dans `.github/workflows/test.yml`, donnerait un gate de conformance multi-révisions sur les 26 outils — bien meilleur retour sur investissement que d'écrire une suite de conformance maison, et un filet de sécurité direct pour toute migration vers un cœur stateless.

Côté Server Cards, le bénéfice est **nul aujourd'hui** : extension non acceptée, aucun SDK officiel ne l'implémente, et la spec impose que les extensions soient désactivées par défaut. À classer en veille, pas en action.

**Risque si on ne fait rien.**

Faible mais réel, sur deux axes. (1) Réputationnel : un serveur absent du registre officiel sera de plus en plus traité comme non vérifié par les annuaires de connecteurs aval — et le `mcpName` orphelin actuel est pire qu'une absence, parce qu'il suggère une publication inexistante. (2) Conformance : sans gate Inspector, chaque évolution du transport HTTP (`src/serve-http.ts`, 1464 lignes, un routeur `if/else if` sur `url`) peut casser silencieusement une révision de protocole que personne ne teste — le dépôt a déjà vécu ce type de dérive avec trois endpoints écrits, testés unitairement et jamais câblés dans le routeur (`protocole-mcp-03`).

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `package.json` (ligne 4) | `"mcpName": "io.github.swoofer/mcp-coordinator"` déjà présent ; `version: 2.0.1` devra rester synchronisée avec `server.json.version` à chaque release |
| `server.json` (racine, **à créer**) | N'existe pas. `$schema`, `name` (= `mcpName`), `description`, `repository`, `packages[]` décrivant le paquet npm `mcp-coordinator` et/ou l'image GHCR |
| `src/server-setup.ts:226-235` (champ `name` en 233) | `new McpServer({ name: "io.github.swoofer/mcp-coordinator", version: VERSION })` — déjà aligné sur `mcpName`. Tout changement de namespace (DNS plutôt que `io.github.*`) casse cet alignement et le commentaire `protocole-mcp-13` juste au-dessus |
| `.github/workflows/release.yml` | Job `release` : `release-please` → `pnpm publish --provenance` (ligne 102), puis jobs chaînés `docker` et `binaries`. Un step `mcp-publisher publish` s'insérerait après le publish npm, gaté sur `steps.release.outputs.release_created` comme les autres |
| `.github/workflows/test.yml` | Matrice vitest Node 22/24 + `sdk-test` + `build-no-native`. Aucun step Inspector aujourd'hui ; c'est là que le gate de conformance CLI se brancherait |
| `src/serve-http.ts:667-740` | Chaîne de routage `if (url === …)` : `/livez` (667), `/readyz` (670), `/health` (673), `/healthz` (679), `/health/ready` (686), `/.well-known/oauth-authorization-server` (695, gaté sur `ctx.phase2Bootstrap`), `/metrics` (702), `/metrics/auth` (719, gaté sur `ctx.phase2Bootstrap`), `/api/events` (732), `url.startsWith("/api/auth/")` (734), `/mcp` (740). Un `/server-card` s'ajouterait ici, à côté du discovery doc |
| `src/discovery.ts` (51 lignes) | Patron exact à copier pour servir un document de métadonnées statique : `buildDiscoveryDoc(publicUrl)` + `handleDiscovery(req, res, publicUrl)`, `Cache-Control: public, max-age=86400`. Une `buildServerCard()` suivrait la même forme, avec `remotes[].url` dérivé de `COORDINATOR_PUBLIC_URL` |
| `cli/doctor.ts:59-102` | `mcpInitialize()` code en dur `protocolVersion: "2024-11-05"` ; c'est la seule sonde protocolaire. Candidat naturel à un remplacement ou à un doublage par l'Inspector CLI |
| `tests/integration/mcp-session-cors-expose.test.ts:58`, `tests/integration/stdio-log-purity.test.ts:116` | Deux révisions différentes en dur (`2025-03-26`, `LATEST_PROTOCOL_VERSION`) : la matrice « protocol eras » n'existe nulle part de façon centralisée |
| `docs/maintainer-notes.md:108-116` | Section « MCP registry publication: deferred » — à réécrire quelle que soit la décision |
| `audit/09-protocole-mcp.md:224-234` | Constat `protocole-mcp-13`, dont cette fiche est la reprise en veille |
| `docs/openapi.yaml` | Décrit déjà `/.well-known/oauth-authorization-server` (ligne 901) ; un `/server-card` devrait y être ajouté pour ne pas recréer un drift contrat/routeur |
| `.well-known/security.txt` (racine du dépôt) | Précédent de fichier `.well-known` versionné, mais servi depuis une page projet GitHub Pages (`swoofer.github.io/mcp-coordinator`), **pas** depuis la racine d'un domaine possédé — ce qui bloque l'auth HTTP `/.well-known/mcp-registry-auth` sans nom de domaine propre |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Est-ce que mcp-coordinator publie une identité **remote** — `server.json` avec des `remotes[]` et un `/server-card` annonçant une URL de coordinateur — ou reste-t-il un serveur **purement local** dont le `server.json` ne déclare qu'un `packages[]` npm/GHCR, sachant qu'aucun déploiement mono-poste n'a d'URL publique stable à annoncer et que le seul namespace vérifiable sans nom de domaine est `io.github.swoofer/*` ?

### 6.2 Hypothèse

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

<Proposition de la veille, à amender pendant le challenge. Le principe maison : on teste le vrai chemin de code, on ne théorise pas.>

- [ ] `GET https://registry.modelcontextprotocol.io/v0.1/servers?search=mcp-coordinator` — vérifier si une entrée existe déjà (le `mcpName` est dans `package.json` depuis plusieurs versions) ou si le nom est libre.
- [ ] Générer un `server.json` avec `mcp-publisher init` dans un dossier jetable, le remplir depuis `package.json` (2.0.1, repository, packages npm + GHCR), et confirmer que le schéma `2025-12-11` accepte les deux `registryType` sans champ obligatoire manquant. **Ne pas publier** à ce stade.
- [ ] Faire tourner le client CLI de l'Inspector contre `pnpm dev` (`src/serve-http.ts`, port par défaut) sur au moins deux révisions de protocole, et compter combien des 26 outils passent — c'est la mesure qui décide si le gate CI vaut son coût.
- [ ] Rejouer la même chose contre le transport stdio (`pnpm dev:stdio`) : le smoke test `tests/integration/stdio-log-purity.test.ts` couvre la pureté du flux, pas la conformance protocolaire.
- [ ] Chronométrer le step Inspector ajouté à `.github/workflows/test.yml` : au-delà de ~2 min sur une matrice déjà à 3 jobs, l'arbitrage change.

### 6.4 Résultat observé

<À remplir pendant le challenge. Rien n'a été testé à ce jour.>

### 6.5 Contre-arguments

- **Le registre n'est pas GA.** L'encadré du quickstart officiel annonce des *breaking changes* et des *data resets* possibles. Publier maintenant, c'est accepter de republier après un reset et de suivre les évolutions du schéma (`2025-12-11` est déjà daté) — pour un projet à mainteneur unique, c'est de la maintenance récurrente contre un bénéfice de référencement non mesuré.
- **Le namespace enferme.** L'auth GitHub impose `io.github.swoofer/*`. Basculer plus tard sur un namespace DNS suppose un nom de domaine possédé — `swoofer.github.io/mcp-coordinator` est une page projet, la racine `.well-known` du domaine appartient à GitHub — et impose de changer `mcpName`, `serverInfo.name` (`src/server-setup.ts:232`), la doc, et probablement de republier sous un nouveau nom. Le coût du changement est plus élevé que celui de l'entrée.
- **Le registre ne protège de rien.** Pas de scan de sécurité, modération minimale (illégal/malware/spam/serveurs cassés, via issues et denylist). L'argument « identité vérifiable » vaut ce que vaut la vérification de namespace, c'est-à-dire une preuve de contrôle du compte GitHub — ce que le champ `repository` du `package.json` npm indique déjà.
- **Les Server Cards ne servent personne aujourd'hui.** Extension explicitement « not an accepted or official MCP extension », SEP-2127 ouverte depuis janvier 2026 et toujours non mergée, aucun SDK officiel ne la lit, et la spec impose que les extensions soient désactivées par défaut. Servir `/server-card` reviendrait à ajouter une route et un document de plus à maintenir dans `src/serve-http.ts` pour zéro consommateur.
- **Le modèle de déploiement contredit le cas d'usage.** Une Server Card sert à faire découvrir un serveur **distant**. mcp-coordinator est un daemon local partagé entre sessions sur une même machine ou un même réseau ; pour `localhost`, aucun mécanisme de découverte n'est spécifié, et l'AI Catalog (`/.well-known/ai-catalog.json`) suppose un domaine public. Le « bootstrap sans configuration » du flux `mcp-coordinator init` n'est donc **pas** fourni par la spec.
- **YAGNI, déjà tranché une fois.** `docs/maintainer-notes.md:108` acte que la publication est différée parce qu'elle engage le mainteneur (vérification de propriété, engagement de mise à jour) et ne doit pas être amorcée par un simple constat d'audit. Rien dans le bundle ne contredit ce raisonnement — la seule chose qui a changé, c'est que l'incohérence `mcpName` sans `server.json` est désormais documentée deux fois.
- **L'Inspector en CI ajoute une dépendance externe au chemin de test.** Un outil tiers dans `.github/workflows/test.yml` peut casser le CI sur une release de l'Inspector sans qu'une seule ligne du projet ait bougé — d'autant que l'Inspector V2 Working Group annonce une refonte. La suite vitest actuelle est autonome ; ce n'est pas rien à sacrifier.
- **Les trois briques n'ont pas le même profil de risque et ne doivent pas être adoptées en bloc.** L'Inspector est GA et indépendant du reste ; le registre est en preview ; les Server Cards sont expérimentales. Traiter la fiche comme une seule décision serait une erreur d'arbitrage.

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
| 2026-08-14 | Vérification des faits : contradiction `validate` tranchée, numéros de ligne §4/§5 corrigés, statut *preview* confirmé. |
