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
| **Statut du challenge** | ✅ **tranché** (2026-08-15) — `reporter` le registre, `refuser` les Server Cards et le gate CI |

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

> Pré-enregistrée le 2026-08-15, **avant** toute exécution (le seul fait déjà collecté est la
> requête registre ci-dessous, qui était la case 1 du protocole).

**La fiche a raison sur un point et il faut le dire d'emblée : les trois briques n'ont pas le même
profil et ne peuvent pas recevoir un verdict unique.** Mon attente, brique par brique :

- **Registre.** Le nom est libre (`{"servers":[],"metadata":{"count":0}}`, re-vérifié aujourd'hui).
  Le vrai sujet n'est pas « remote ou local » — la question de §6.1 est *déjà tranchée par le
  modèle de déploiement*, un daemon mono-poste n'a aucune URL publique à annoncer, donc
  `packages[]` seul. Le vrai sujet est l'**incohérence** : `mcpName` promet une publication qui
  n'existe pas. Je m'attends à ce que `mcp-publisher validate` accepte un `server.json` construit
  depuis `package.json`, et à ce que l'effort tienne en 2 fichiers + 1 step CI.
- **Server Cards.** Je m'attends à `refuser`. [`A09`](A09-extensions-grouping-skills.md) vient de
  mesurer (2026-08-15) que Claude Code 2.1.233 n'émet **aucun** `extensions` et que le véhicule
  normatif d'opt-in est à 0 occurrence dans le SDK installé. Une extension non acceptée, SEP
  ouverte depuis janvier, zéro SDK : rien à consommer.
- **Inspector.** C'est la brique que je crois la plus prometteuse, **et c'est précisément celle
  dont je me méfie le plus** — le dépôt a déjà le précédent [`A06`](A06-tool-metadata-modern-surface.md) :
  *« le mécanisme marche, mais il n'a rien à garder »*. Un gate qui ne trouve rien et ne peut rien
  trouver est du coût pur.

**Verdict attendu :** `adopter partiellement` — registre oui, Server Cards non, Inspector selon
ce qu'il trouve.

**Critères de refus, chiffrés (pré-enregistrés) :**

| # | Brique | Le résultat qui tue |
|---|---|---|
| **K1** | registre | `mcp-publisher validate` **rejette** un `server.json` construit depuis `package.json`, ou le schéma `2025-12-11` exige un champ que le dépôt ne peut pas fournir → `reporter`, blocage nommé. |
| **K2** | registre | La publication exige un **nom de domaine possédé** (auth DNS/HTTP) ou un rôle GitHub qu'on n'a pas. `swoofer.github.io/mcp-coordinator` est une page projet — la racine `.well-known` appartient à GitHub. |
| **K3** | registre | L'effort dépasse **2 fichiers créés + 1 step CI**, ou impose un couplage de version supplémentaire ingérable à la main. |
| **K4** | registre | **Aucun consommateur mesurable.** Si rien dans l'outillage réel (Claude Code en tête) ne lit ce registre, l'entrée ne sert qu'à faire taire un constat d'audit — et `docs/maintainer-notes.md:108` a déjà tranché « différé » pour cette raison exacte. |
| **K5** | Inspector | Le CLI trouve **0 écart** sur ≥ 2 révisions de protocole × 2 transports **et** ce qu'il vérifie est déjà couvert par la suite vitest → gate qui ne garde rien, motif `A06`. |
| **K6** | Inspector | Le step dépasse **2 min** sur une matrice déjà à 3 jobs. |
| **K7** | Inspector | Le CLI ne tourne pas ici (Node, auth, transport) → `reporter` avec blocage nommé, jamais `adopter`. |
| **K8** | Server Cards | Aucun client ne lit `/server-card`. |

**Critère d'adoption (ce qu'il faudrait pour dire oui), brique par brique :**
registre → un `server.json` **validé par l'outil officiel** + un consommateur nommé ;
Inspector → **au moins un écart réel trouvé** que la suite actuelle ne voit pas, sous 2 min ;
Server Cards → un consommateur qui lit la route.

### 6.3 Protocole de vérification

> Amendé le 2026-08-15. Les cases 1 à 5 sont celles de la veille ; la case 6 est ajoutée parce
> que **K4 est le critère qui décide réellement du sort du registre** et que la veille ne
> l'instrumentait pas.

- [x] **P1** — `GET registry.modelcontextprotocol.io/v0.1/servers?search=mcp-coordinator` : entrée
      existante ou nom libre ?
- [x] **P2** — `mcp-publisher init` dans un dossier jetable, remplir depuis `package.json`
      (2.0.1, repository, npm + GHCR), puis `mcp-publisher validate`. **Ne pas publier.**
- [x] **P3** — Inspector CLI contre `pnpm dev` (HTTP) sur ≥ 2 révisions de protocole ; compter
      combien des 26 outils passent.
- [x] **P4** — Rejouer en stdio (`pnpm dev:stdio`).
- [x] **P5** — Chronométrer le step Inspector.
- [x] **P6 (ajouté)** — **Chercher le consommateur.** Est-ce que l'outillage réellement installé
      lit ce registre ? Sonder Claude Code 2.1.233 (`claude mcp --help` et sous-commandes),
      et vérifier ce que le registre expose comme surface de consommation. Sans consommateur
      nommé, K4 se déclenche et le registre tombe.

### 6.4 Résultat observé

> Exécuté le 2026-08-15 sur ce poste (Windows 11, Node v22.21.0), contre le daemon réel
> (`pnpm dev`, port 3100) et en stdio (`dist/src/index.js`). Tout ce qui suit sous (A) à (F) a été
> **exécuté** ; (G) est de la preuve documentaire ; (H) nomme ce qui ne l'a pas été.

#### (A) P1 — Le nom est libre, re-vérifié aujourd'hui

```
$ curl -s "https://registry.modelcontextprotocol.io/v0.1/servers?search=mcp-coordinator"
{"servers":[],"metadata":{"count":0}}
```

Identique au 2026-08-14. `io.github.swoofer/mcp-coordinator` n'est pas publié et reste disponible.

#### (B) P2 — `mcp-publisher` : le `server.json` est quasi auto-généré, et il valide

Binaire officiel `mcp-publisher_windows_amd64` de la release **v1.8.1** (publiée le 2026-08-06),
téléchargé et exécuté ici. Les **six** sous-commandes de §2 sont confirmées mot pour mot :

```
init | login | logout | publish | status | validate
```

`init` lancé dans un dossier jetable contenant une copie du `package.json` du dépôt **dérive tout
seul** le nom, la description, le repository, la version et le paquet npm :

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "io.github.swoofer/mcp-coordinator",
  "description": "Embedded MQTT broker + MCP server for multi-agent coordination",
  "repository": { "url": "https://github.com/swoofer/mcp-coordinator", "source": "github" },
  "version": "2.0.1",
  "packages": [ { "registryType": "npm", "identifier": "mcp-coordinator",
                  "version": "2.0.1", "transport": { "type": "stdio" } } ]
}
```

Seul le bloc `environmentVariables` est un placeholder (`YOUR_API_KEY`) à retirer. Après
remplacement des `packages[]` par les deux vrais artefacts du projet — npm **et** l'image GHCR :

```
$ ./mcp-publisher.exe validate
Validating against https://registry.modelcontextprotocol.io...
✅ server.json is valid
```

**K1 ne se déclenche pas.** Le schéma `2025-12-11` accepte `registryType: npm` **et**
`registryType: oci` dans le même document, sans champ obligatoire manquant.
**K2 ne se déclenche pas non plus** : le namespace `io.github.swoofer/*` s'authentifie par device
flow GitHub, aucun nom de domaine requis.

#### (C) P3 / P4 — L'Inspector CLI : 26/26 sur les deux transports, mais ce n'est pas un gate

```
$ npx @modelcontextprotocol/inspector --cli --server-url http://127.0.0.1:3100/mcp \
      --transport http --method tools/list --format json
exit=0   duree_ms=5302   outils listes: 26
cles d un outil: name,description,inputSchema,annotations,execution
outils avec annotations: 26   avec execution: 26

$ npx @modelcontextprotocol/inspector --cli node dist/src/index.js \
      --method tools/list --format json
exit=0   duree_ms=6991   outils (stdio): 26
```

> ⚠️ **Correction de ma propre mesure, apportée par la passe adversariale et re-vérifiée par moi.**
> J'avais écrit ici que *« le client CLI de l'Inspector n'a aucun flag de version de protocole »*
> et que la prémisse du §4 s'effondrait. **C'est faux : j'avais grepé la mauvaise surface.**
> L'ère se règle par le **fichier de config**, pas par un flag — champ `protocolEra` par serveur.
> Rejoué par moi, trois configs, même URL, même daemon :
>
> ```
> ===== protocolEra=legacy =====  exit=0   outils: 26
> ===== protocolEra=auto   =====  exit=0   outils: 26
> ===== protocolEra=modern =====  exit=1   (stdout vide)
> {"error":{"code":"error","message":"Version negotiation failed: the server did not offer
>  pinned protocol version 2026-07-28 via server/discover (no fallback in pin mode)"}}
> ```
>
> **Donc l'Inspector sait épingler une ère, et c'est le seul des deux outils qui atteint la
> frontière `2026-07-28`** — `conformance --spec-version` ne connaît que `2025-06-18` et
> `2025-11-25`. Exit 1 + une ligne JSON sur stderr : c'est gatable en CI.
>
> **Ce que ça ne change pas :** ce qu'il rapporte est **déjà connu et déjà tranché**. `legacy` et
> `auto` verts, `modern` rouge, c'est exactement la mesure de [`A01`](A01-mcp-2026-07-28-stateless.md)
> (« le repli fonctionne ; seul `{pin: '2026-07-28'}` échoue »), fiche **reportée**. L'Inspector
> confirmerait en CI un état de fait déjà documenté et volontairement non corrigé.

L'Inspector reste par ailleurs un **client**, pas une suite de tests : hors épinglage d'ère, il
relaie `tools/list` et affiche le résultat sans rien valider.

#### (D) Ce qui est réellement le gate : `@modelcontextprotocol/conformance`

C'est un **autre paquet**, que §2 mentionne mais que §4 et §6.3 ignorent au profit de l'Inspector.
Il a bien un mode serveur et un filtre de version de spec :

```
$ npx @modelcontextprotocol/conformance server --help
  --url <url>                URL of the server to test
  --scenario <scenario>      Scenario to test (defaults to active suite)
  --suite <suite>            "active" (default) | "all" | "pending"
  --expected-failures <path> Path to YAML file listing expected failures (baseline)
  --spec-version <version>   Filter scenarios by spec version
```

Résultat contre le daemon, **suite complète** :

```
Total: 9 passed, 23 failed          duree: 6 614 ms
```

Et **sur les deux ères de protocole**, ce que l'Inspector ne sait pas faire :

| `--spec-version` | scénarios | passés | durée |
|---|---|---|---|
| `2025-06-18` | 26 | **5** | 6 126 ms |
| `2025-11-25` | 30 | **9** | 6 117 ms |

```
2025-11-25 PASSE : server-initialize, ping, tools-list, tools-call-simple-text,
                   tools-call-error, server-sse-multiple-streams, dns-rebinding-protection
2025-06-18 PASSE : server-initialize, ping, tools-list, tools-call-simple-text,
                   tools-call-error
present en 11-25 mais pas en 06-18 : server-sse-multiple-streams, dns-rebinding-protection
```

**Les 2 scénarios « en plus » ne sont pas une régression sur l'ère ancienne : ils n'existent pas
en `2025-06-18`** (`server-sse-multiple-streams [2025-11-25]` et `dns-rebinding-protection
[2025-11-25]` dans `conformance list`). Sur les 5 scénarios communs applicables, le daemon se
comporte **à l'identique** sur les deux ères. **Aucun défaut spécifique à une révision.**

#### (E) K5 — Les 23 échecs sont des primitives absentes, pas des défauts

Dépouillés un par un. Deux motifs, aucun n'est un bug :

```
$ ... --scenario logging-set-level --verbose
  - LoggingSetLevel: Server accepts logging level setting
    Error: Failed: MCP error -32601: Method not found
```

Le daemon ne déclare **pas** la capability `logging` (son `initialize` ne renvoie que
`{"tools":{"listChanged":true}}`) : répondre `-32601` est le **comportement correct**. La suite
teste inconditionnellement, sans se gater sur les capabilities annoncées. Même motif pour
`resources/*`, `prompts/*`, `completion-complete`.

```
$ ... --scenario tools-call-image
  - ToolsCallImage: Tool returns image content   Error: No image content found
$ ... --scenario tools-call-with-progress
  - ToolsCallWithProgress: Tool reports progress notifications
    Error: No progress notifications received
$ ... --scenario server-sse-polling
  - IncomingSseEvent: Received tool response on POST stream   Error: Tool call failed
    (« Test server SSE polling via test_reconnection tool », SEP-1699)
```

Ces scénarios exigent les **outils du serveur de référence** (`test_reconnection`, des outils
renvoyant image/audio/ressource embarquée). On ne les a pas, et on n'a aucune raison de les avoir.

**Conclusion sur K5 : 0 défaut réel trouvé, sur 2 ères et 2 transports.** La suite n'est pas
utilisable telle quelle comme gate — elle serait rouge en permanence. Elle ne le devient qu'avec
un fichier `--expected-failures` figeant les 23, après quoi elle ne garde plus que **7 scénarios /
9 checks**, tous déjà verts.

**Deux avertissements SHOULD, en revanche, portent bien sur notre transport :**

```
[server-sse-priming-event] WARNING Server SHOULD send priming event with id and
                                   empty data on POST SSE streams
[server-sse-retry-field  ] WARNING Server SHOULD send retry field to control client
                                   reconnection timing
```

C'est la seule chose que ce challenge ait trouvée que la suite vitest ne voit pas. Ils viennent du
`StreamableHTTPServerTransport` du SDK, pas de code du dépôt.

#### (F) K6 — Le coût en temps est négligeable

Suite complète : **6,6 s**. Par ère : **6,1 s**. Inspector : 5,3 s (HTTP), 7,0 s (stdio).
Très loin du seuil de 2 min. **K6 ne se déclenche pas.** Le coût du gate n'est pas le temps —
c'est la dépendance et le baseline à maintenir.

**Coût de maintenance trouvé en séance, que la fiche ne mentionne pas :**
`release-please-config.json` n'a **aucune** entrée `extra-files`. Un `server.json` ne serait donc
**pas** bumpé par release-please, et sa `version` divergerait de `package.json` dès la release
suivante — le registre annoncerait une version qui n'existe plus. Publier impose donc de toucher
`release-please-config.json` en plus de `release.yml`. *(La passe adversariale a précisé que ce
coût est plus faible que je ne l'ai écrit : `extra-files` accepte
`{"type":"json","path":"server.json","jsonpath":"$.version"}`, donc la synchronisation est
entièrement automatisable en ~3 entrées. L'effort **S** tient.)*

#### (F bis) Ce que la passe adversariale a démoli dans mes propres mesures

**Deux des scénarios que j'ai comptés comme « passés » sont des faux positifs.** Vérifié par moi
après signalement, `--verbose`, contre le daemon :

```
===== tools-call-simple-text =====
    "status": "SUCCESS",
            "text": "MCP error -32602: Tool test_simple_text not found"
        "isError": true
Passed: 1/1, 0 failed, 0 warnings

===== tools-call-error =====
    "status": "SUCCESS",
            "text": "MCP error -32602: Tool test_error_handling not found"
        "isError": true
Passed: 1/1, 0 failed, 0 warnings
```

Le scénario **« Tool returns simple text content » rapporte SUCCESS alors que le serveur a répondu
*tool not found***. Ni `test_simple_text` ni `test_error_handling` n'existent dans le daemon :
l'assertion (« le tableau `content` contient un item texte », « `isError===true` et
`content[0].text` non vide) est satisfaite par notre chemin outil-inconnu. **Un gate CI bâti
dessus rapporterait vert sur des scénarios qu'il ne teste pas.**

La couverture unique réelle, faux positifs retirés, se réduit à : `server-initialize` (la connexion
aboutit), `ping`, `tools-list` (validité structurelle), plus en `2025-11-25` seulement
`server-sse-multiple-streams` et `dns-rebinding-protection` — ce dernier déjà couvert par
`tests/integration/origin-cors.test.ts`.

**Et les 2 avertissements SHOULD ne sont pas un écart : c'est UNE décision, déjà prise et close.**
Mon attribution « ça vient du SDK, pas du dépôt » était fausse dans les deux sens. Le SDK
(`server/webStandardStreamableHttp.js:199-211`) sort en tête de `writePrimingEvent` :

```js
async writePrimingEvent(controller, encoder, streamId, protocolVersion) {
    if (!this._eventStore) { return; }        // <-- les DEUX warnings viennent d'ici
    ...
    if (this._retryInterval !== undefined) { primingEvent = `id: …\nretry: …` }
```

`grep -rn "eventStore\|retryInterval" src/` → **0 occurrence**. C'est donc bien **notre** choix,
et il est écrit noir sur blanc dans `docs/maintainer-notes.md:98-106` :
*« This is intentional (YAGNI), not an oversight … **Policy**: implement the SDK's `EventStore`
interface … only if a concrete client need emerges. »* — et l'item d'audit correspondant
`protocole-mcp-11` est **✅ clos** (`audit/TRACKING.md:71`, commit `dec5123`,
« CORS ; eventStore YAGNI documenté »).

**La suite ne trouve donc rien : elle re-signale une politique délibérée, instruite et close.**

**Mon argument prospectif était faux, et c'est la correction la plus importante.** J'allais adopter
le gate en invoquant la migration SDK d'[`A02`](A02-mcp-sdk-typescript-v2.md), déjà décidée. Or son
§7 exclut explicitement `server/discover`, `createMcpHandler`, `toNodeHandler`, garde
`NodeStreamableHTTPServerTransport` avec `sessionIdGenerator`, gèle la négociation à `2025-11-25`,
et dit mot pour mot que *« le renommage 1:1, lui, ne rapporte rien sur le protocole »*. Le gate
protégerait une migration dont le dépôt a lui-même établi qu'elle ne touche pas le protocole — et
la seule régression qu'A02 a réellement rencontrée (outil inconnu → `ProtocolError` au lieu d'un
résultat structuré) a été **attrapée par `mcp-stdio-smoke.test.ts`**, c'est-à-dire par vitest.

**Coût caché de l'outil, que je n'avais pas mesuré :** `@modelcontextprotocol/conformance` est en
**0.1.16**, son README dit *« This repository is a work in progress and is unstable »*, 26 versions
en 9 mois, et une ligne `0.2.0-alpha.11` en vol. Son baseline `--expected-failures` est
**bidirectionnellement strict** : un scénario qui se met à **passer** alors qu'il est encore listé
fait sortir en erreur. La CI virerait donc au rouge quand **l'outil** bouge, pas seulement le
projet — et SEP-2484 garantit par construction que le jeu de scénarios grossit.

#### (F ter) Deux critères de mort étaient acquis d'avance — à dire

- **K7** (« le CLI ne tourne pas ici ») : la §0 du 2026-08-14, soit la veille du pré-enregistrement,
  écrit déjà *« Testabilité : ✅ testable — Tout le §6.3 est exécutable sur ce poste »*.
- **K2** (« un domaine possédé requis ») : §2 documentait déjà le device flow GitHub sans domaine,
  `package.json:4` porte déjà `io.github.swoofer/*`, et §6.5 — écrite par la veille — dit déjà
  *« L'auth GitHub impose `io.github.swoofer/*` »*.

Sur 8 critères, **2 étaient décoratifs**. K1, K3, K4, K5 et K6 étaient de vrais tests.

#### (G) P6 / K4 — Le consommateur : « aucun » est faux, « à portée de 1 % » est vrai

La doc du registre, fetchée aujourd'hui, dit deux choses qui semblent s'opposer :

> « The MCP Registry is **not intended to be directly consumed by host applications**. Instead,
> host applications should consume other MCP registries, such as downstream marketplaces… »
> « The MCP Registry is intended to be consumed primarily by **downstream aggregators**… »
> — `modelcontextprotocol.io/registry/about`, statut toujours *preview* :
> « Breaking changes or **data resets** may occur before general availability. »

Donc « pas de consommateur direct » n'est **pas** un argument : c'est l'architecture voulue.
La bonne question est si la chaîne agrégateur fonctionne. **Vérifié par moi, elle fonctionne :**

```
$ curl -s "https://api.mcp.github.com/v0/servers?limit=1"
metadata: {"next_cursor":"…","count":1,"total":219,"total_pages":219}
CLES ENTREE: server, x-github, x-io.modelcontextprotocol.registry

--- io.github.netdata/mcp-server
  x-io.mcp.registry: {"id":"3f5161cc…","is_latest":true,"published_at":"2026-08-12T18:38:43Z",…}
$ curl -s "…/v0.1/servers?search=netdata"  ->  io.github.netdata/mcp-server v2.10.0/1/2
```

Chaque entrée du registre GitHub porte un bloc de provenance `x-io.modelcontextprotocol.registry`
avec l'`id` et les horodatages du registre officiel, et le même serveur existe des deux côtés.
**L'ingestion officiel → GitHub est réelle**, et le registre GitHub est ce que la galerie MCP de
VS Code interroge par défaut. PulseMCP annonce de son côté une section
*« Integration with the Official MCP Registry »* — **sans en documenter le mécanisme** (fetch fait
aujourd'hui ; l'affirmation « directly piped » avancée par la passe adversariale n'est pas étayée
par cette page, je ne la retiens pas).

**Mais la chaîne est massivement lossy : 219 entrées côté GitHub contre ~21 957 côté officiel,
soit ~1 %, et curées.** Publier met dans l'officiel ; ça ne met pas dans GitHub, donc pas dans
VS Code.

**Second fait, mesuré, qui borne la valeur de l'entrée : la recherche du registre porte sur le
nom, pas sur la description.**

```
search=coordination      -> 0        search=multiagent -> 0
search=coordinator       -> 2 (swarm-coordinator, transaction-coordinator)
search=github-mcp-server -> com.thenextgennexus/github-mcp-server (un proxy Apify tiers)
```

Sous `io.github.swoofer/mcp-coordinator`, le projet ne serait trouvable que par « coordinator »,
« mcp-coordinator » ou « swoofer » — c'est-à-dire **par ceux qui connaissent déjà le nom, et qui
peuvent donc déjà faire `npm i mcp-coordinator`**. Toute la proposition de valeur du projet vit
dans la description, qui n'est pas indexée.

**Verdict sur K4 : il ne se déclenche pas sur sa lettre** — un consommateur nommé et vérifiable
existe. Le motif d'attente est ailleurs, et il est chiffré : 1 % de portée, curée, sur une
recherche qui n'indexe pas ce qu'on vend. Voir §7.3.

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
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ✅ **reporter** (registre) · ✅ **refuser** (Server Cards, gate CI) |
| **Date** | 2026-08-15 |
| **Justification** | **Rien n'est adopté, et le résultat le plus utile est que le gate CI proposé par §4 rapporterait vert sur des scénarios qu'il ne teste pas.** Mesuré : `tools-call-simple-text` répond **SUCCESS** sur le payload `"Tool test_simple_text not found"`. Deux des 9 checks verts sont des faux positifs. Registre : `mcp-publisher validate` passe, un consommateur existe (provenance officielle vérifiée dans les 219 entrées de `api.mcp.github.com`), mais la portée est de **~1 %, curée**, et la recherche du registre **n'indexe pas les descriptions** — `search=coordination` → 0. Server Cards : SEP-2127 ouverte depuis janvier, **zéro** implémentation cliente. |
| **Issue / PR** | Aucune. Rien à coder. |
| **Jalon visé** | — |

### 7.1 La réponse à la question de §6.1

**§6.1 est mal cadrée sur deux plans, et la mesure y répond mieux qu'elle ne le demande.**

*Sur le fond*, la question oppose une identité **remote** (`server.json` avec `remotes[]` +
`/server-card`) à une identité **purement locale** (`packages[]` npm/GHCR). **La réponse est
locale, et elle est prouvée, pas argumentée** : le `server.json` qui a réellement passé l'outil
officiel en §6.4 (B) déclare `packages[]` **npm + OCI, sans aucun `remotes[]`**, et
`mcp-publisher validate` répond `✅ server.json is valid`. Un daemon mono-poste n'a pas d'URL
publique stable à annoncer ; le schéma `2025-12-11` n'en exige aucune. La question était réglée
par le modèle de déploiement, et l'outil le confirme.

*Sur le périmètre*, §6.1 ne couvre **que** l'identité — elle ne pose aucune question sur
l'Inspector ni sur la conformance, qui sont pourtant la moitié de la fiche et la seule brique où
ce challenge a trouvé quelque chose. Le verdict porte donc sur trois briques, dont une que la
question à trancher ignore.

### 7.2 Ce qui est refusé, et sur quelle mesure

**(a) Le gate CI de conformance — `refuser`.** Mon critère d'adoption pré-enregistré exigeait
*« au moins un écart réel trouvé que la suite actuelle ne voit pas »*. Quatre mesures le tuent :

1. **0 défaut réel** sur 2 ères × 2 transports (§6.4 E).
2. **2 des 9 checks verts sont des faux positifs** (§6.4 F bis) : le scénario « Tool returns simple
   text content » rapporte SUCCESS sur `"Tool test_simple_text not found"`. Un gate bâti dessus
   ment. Et ce qu'ils exercent réellement — l'outil inconnu — est déjà couvert **trois fois** en
   vitest (`mcp-http-smoke.test.ts:72`, `mcp-stdio-smoke.test.ts:76`, `cli-channel.test.ts:413`).
3. **Les 2 avertissements SHOULD ne sont pas un écart** : ils viennent d'un seul
   `if (!this._eventStore) return;`, conséquence d'un choix **délibéré, documenté**
   (`maintainer-notes.md:98-106`, « intentional (YAGNI), not an oversight ») et d'un item d'audit
   **clos** (`protocole-mcp-11`, ✅ `dec5123`). La suite ne trouve rien : elle relit une décision.
   Et ils **n'apparaissent pas** dans la sortie par défaut — ils sont invisibles pour le gate.
4. **L'outil est instable** : `0.1.16`, README « work in progress and is unstable », 26 versions en
   9 mois, ligne `0.2.0-alpha` en vol, baseline `--expected-failures` **bidirectionnellement
   strict** (un scénario qui se remet à passer fait sortir en erreur). La CI virerait au rouge
   quand l'**outil** bouge. Pour 43 Mo et 117 paquets transitifs ajoutés au chemin de test.

**(b) Les Server Cards — `refuser`.** K8 déclenché : SEP-2127 ouverte depuis le 2026-01-21,
label `in-review`, non mergée ; **zéro** implémentation trouvée dans VS Code, Goose ou les trois
SDK officiels ; l'Inspector planifie le support en **Phase 2 (sept.-nov. 2026)**. Le README du
dépôt d'extension dit lui-même *« not an accepted or official MCP extension »*.

### 7.3 Le registre — `reporter`, et le motif d'attente n'est pas celui que je croyais

**Mon critère d'adoption est atteint sur sa lettre, et il faut le dire.** §6.2 exigeait *« un
`server.json` validé par l'outil officiel + un consommateur nommé »*. Les deux le sont : `validate`
passe, et les 219 entrées de `api.mcp.github.com` portent toutes un bloc de provenance
`x-io.modelcontextprotocol.registry` renvoyant aux `id` du registre officiel. **Mon K4 (« aucun
consommateur mesurable ») ne se déclenche donc pas**, contrairement à ce que j'ai cru jusqu'à la
passe adversariale.

**Ce qui justifie d'attendre est plus étroit, et chiffré :**

- **Portée réelle ~1 %.** 219 entrées côté GitHub contre ~21 957 côté officiel, curées « from
  leading partners ». Publier met dans l'officiel — pas dans GitHub, donc pas dans VS Code.
- **La recherche n'indexe pas les descriptions.** `search=coordination` → 0, `search=multiagent`
  → 0. Le projet ne serait trouvable que par un nom que celui qui le connaît peut déjà taper dans
  `npm i`.
- **Attendre coûte littéralement zéro.** Le namespace `io.github.swoofer/*` est protégé par l'auth
  GitHub : personne d'autre ne peut publier sous ce préfixe. Il n'y a pas de course.
- **Publier coûte de façon irréversible.** Service en *preview* (« data resets may occur »),
  entrées **immuables** (toute correction passe par une issue traitée à la main), et un historique
  de **3 breaking changes de schéma en 4 semaines** (sept.-oct. 2025).
- **Risque de pipeline non anticipé par la fiche** : dans `.github/workflows/release.yml`, les jobs
  `docker` et `binaries` sont `needs: release` **sans `always()`**. Un step `mcp-publisher publish`
  qui échoue ferait échouer le job `release` et **sauterait GHCR et les binaires** alors que npm a
  déjà reçu la version — exactement la panne partielle que `publish_only` a été écrit pour réparer.
  À neutraliser par `continue-on-error: true` si la publication a lieu un jour.

**Ce verdict confirme la décision déjà prise, avec un motif neuf.**
`docs/maintainer-notes.md:108-116` acte « MCP registry publication: **deferred** » et l'item
d'audit `protocole-mcp-13` est **✅ clos** (`dec5123`, « nom aligné ; registre documenté »). La
fiche §4 présente cet état comme une **incohérence ouverte** (« le dépôt est déjà à mi-chemin,
dans un état incohérent », « `mcpName` promet aujourd'hui une publication qui n'existe pas ») :
**c'est périmé**. Vérifié : `mcpName` n'est lu par **aucun** code du dépôt — seulement par le flux
de publication du registre. L'« incohérence » est documentaire, et elle a été résolue en
documentant la décision.

**Condition de réveil, falsifiable et re-mesurable en 30 secondes :**

```bash
# 1. le registre est-il sorti de preview ?  (le bandeau disparaît de /registry/about)
curl -s https://modelcontextprotocol.io/registry/about | grep -c "currently in preview"
# 2. la chaîne agrégateur cesse-t-elle d'être curée ?  (219 aujourd'hui ; réveil si ça suit l'officiel)
curl -s "https://api.mcp.github.com/v0/servers?limit=1" | grep -o '"total":[0-9]*'
```

Réveil si **(1)** passe à `0`, **ou** si **(2)** dépasse ~1 000 — signe que l'ingestion devient
automatique plutôt que partenaire — **ou** au premier utilisateur qui demande l'entrée au registre.

### 7.4 Ce que ce challenge a corrigé, y compris chez moi

- **Une erreur de mesure de ma part, rattrapée par la passe adversariale et re-vérifiée par moi :**
  j'avais conclu que l'Inspector n'avait **aucun** mécanisme de version de protocole, et donc que
  la prémisse « gate multi-révisions » du §4 était fausse. **C'est moi qui avais tort** — j'avais
  grepé les flags du CLI, alors que l'ère se règle par le champ `protocolEra` du fichier
  `--config`. Rejoué : `legacy` et `auto` → 26 outils / exit 0 ; `modern` → **exit 1** avec
  *« the server did not offer pinned protocol version 2026-07-28 via server/discover »*.
  Le §4 avait raison sur la capacité. Ce qui reste vrai, c'est que cette capacité ne rapporte rien
  ici : elle re-mesure exactement le résultat de [`A01`](A01-mcp-2026-07-28-stateless.md),
  fiche **reportée**, dont l'état actuel est un choix assumé.
- **Deux critères de mort étaient acquis d'avance** (K2, K7) — voir §6.4 (F ter). Sur 8, 2 étaient
  décoratifs.
- **§5 se trompe sur `docs/openapi.yaml`** : elle veut y ajouter `/server-card` « pour ne pas
  recréer un drift contrat/routeur ». Or ce fichier est titré *« mcp-coordinator Phase 2 Auth API »*
  et déclare *« Phase 1 REST + MCP routes … are NOT in scope here »*. Ce n'est pas un drift, c'est
  un périmètre assumé — y ajouter `/server-card` le violerait.
- **§4 est périmé sur l'« état incohérent »** — voir §7.3.

### 7.5 Ce qui reste ouvert et n'appartient pas à cette fiche

**L'absence de reprise SSE est réelle, connue, et volontaire — mais elle mérite d'être re-regardée
un jour.** `src/serve-http.ts:801-805` construit le transport sans `eventStore` ni `retryInterval`,
donc pas de rejeu `Last-Event-ID` : un client qui perd son flux SSE en cours d'appel perd la
réponse. C'est documenté comme YAGNI (`maintainer-notes.md:104-106`) au motif que MQTT/SSE couvre
le push durable, et l'item d'audit est clos. Le SDK fournit un `InMemoryEventStore` d'exemple et
l'interface `EventStore` a 3 méthodes. **Rien à faire tant que la politique tient** — mais c'est le
seul point de ce challenge où un outil externe a pointé une limite réelle du produit, et il
appartient à `protocole-mcp-11`, pas à A10.

**Trois chaînes de version divergent déjà** dans le dépôt, trouvé en séance :
`package.json` **2.0.1**, `docs/openapi.yaml` `info.version` **0.8.0**, et le README épingle
`ghcr.io/swoofer/mcp-coordinator:0.13.0`. Sans rapport avec le registre, mais c'est le contexte
réel dans lequel un `server.json` de plus devrait être maintenu.

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : contradiction `validate` tranchée, numéros de ligne §4/§5 corrigés, statut *preview* confirmé. |
| 2026-08-15 | Challenge. `mcp-publisher` v1.8.1 exécuté ici, suite de conformance jouée sur 2 ères × 2 transports contre le daemon réel, Inspector CLI en 3 configs d'ère, 3 réfutateurs adversariaux. **Verdict : `reporter` le registre, `refuser` les Server Cards et le gate CI.** Mesuré : `validate` ✅ avec npm + OCI ; **2 des 9 checks verts de la suite sont des faux positifs** (`tools-call-simple-text` rapporte SUCCESS sur `"Tool test_simple_text not found"`) ; 0 défaut réel ; les 2 warnings SHOULD viennent d'un `eventStore` volontairement absent, déjà clos en `protocole-mcp-11` ; registre à ~1 % de portée (219 vs ~21 957) et `search=coordination` → 0. **La passe adversariale a corrigé une erreur de mesure de ma part** : l'Inspector *sait* épingler une ère (`protocolEra` dans `--config`, `modern` → exit 1), contrairement à ce que j'avais conclu ; et **mon argument prospectif pour adopter le gate était faux** — A02 gèle le transport et la négociation. Corrections portées à §4 (état « incohérent » périmé, `protocole-mcp-13` clos) et §5 (`openapi.yaml` a un périmètre assumé, pas un drift). |
