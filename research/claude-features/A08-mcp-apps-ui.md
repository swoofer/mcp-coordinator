# A08 — MCP Apps (`ui://`) : le dashboard rendu dans la conversation

| Champ | Valeur |
|---|---|
| **ID** | `mcp-apps-ui` |
| **Surface** | mcp-spec |
| **Statut** | Extension officielle, spec « Stable (2026-01-26) » — support hôte partiel (extension opt-in, désactivée par défaut ; « GA » n'est pas un label MCP) |
| **Disponible depuis** | Proposition SEP-1865 (blog 2025-11-21), spec `2026-01-26`, extension officielle référencée par la release core `2026-07-28` |
| **Tier** | ~~T2-fort-levier~~ **T3** (challenge 2026-08-15 : bloqué sur un tiers, aucun bénéficiaire mesuré) |
| **Nature** | ~~replace-homemade-code~~ **opportunity** (challenge 2026-08-15 : on n'enlève rien, cf. §6.4-E) |
| **Effort estimé** | L pour le portage complet · **S** pour l'app minimale (mesuré : 11 lignes, 1 fichier, 43 tests PASS — cf. §7.2) |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — serveur testable en local, rendu exige un hôte tiers |
| **Statut du challenge** | ✅ tranché — **reporter** (2026-08-15), voir §7 |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

Le cœur de la fiche tient : l'extension existe, l'identifiant, le schéma d'URI, le mimeType, le
mécanisme de négociation et la réserve « Claude Code absent de la matrice » sont tous confirmés
mot pour mot sur la doc officielle (`modelcontextprotocol.io/extensions/client-matrix` et
`/extensions/overview#negotiation`, consultées le 2026-08-14). Les corrections portent sur des
détails de surface d'API sous-spécifiés et sur trois erreurs de repérage dans le repo.

**Corrections apportées :**

- **Statut** — remplacé « GA » par « extension officielle, spec Stable (2026-01-26) ». MCP
  n'emploie pas le label GA pour les extensions ; la doc précise que « les extensions sont
  toujours désactivées par défaut et exigent un opt-in explicite ». La liste des 11 hôtes de la
  matrice est **exacte**, et **Claude Code y est toujours absent au 2026-08-14**.
- **§2 `_meta.ui.csp`** — n'est pas une liste d'origines mais un objet à quatre champs :
  `connectDomains`, `resourceDomains`, `frameDomains`, `baseUriDomains`.
- **§2 `_meta.ui.permissions`** — champs exacts : `camera`, `microphone`, `geolocation`,
  `clipboardWrite`.
- **§2** — deux champs de ressource manquaient : `domain` (origine de sandbox dédiée) et
  `prefersBorder`.
- **§2 méthodes `ui/`** — `ui/initialize` seul était cité ; la liste réelle a été ajoutée.
- **§2 marqueur `(à vérifier)` SDK — TRANCHÉ.** Le repo déclare `^1.29.0` (`package.json:69`)
  et résout sur **`@modelcontextprotocol/sdk@1.30.0`**. `registerTool(name, config, cb)` accepte
  bien `_meta?: Record<string, unknown>`, et `registerResource(name, uri: string, config:
  ResourceMetadata, cb)` accepte une URI arbitraire (donc `ui://`) avec `mimeType`. **Aucun
  besoin de `@modelcontextprotocol/ext-apps` côté serveur.** Mais le repo utilise partout la
  surcharge **dépréciée** `server.tool(name, desc, schema, annotations, cb)`, qui n'a **pas** de
  slot `_meta` : porter la fiche impose de migrer les outils concernés vers `registerTool`.
- **§4** — la taille « ~48 Ko » est celle de `dashboard.js` seul ; l'artefact complet
  (`index.html` + `dashboard.js`) fait ~64 Ko.
- **§5 `src/serve-http.ts`** — la branche `/dashboard` court de la ligne 583 à la ligne **666**
  (et non 660 ; les en-têtes CSP sont bien à 655-660, mais le `return;` du bloc est à 666).
- **§5 `sdk/src/client.ts`** — affirmation fausse : ce fichier ne contient **aucune** occurrence
  de `getSessionClaims` ni de `claims`. C'est le client HTTP SDK (flux OAuth, refresh de tokens).
  `getSessionClaims` vit dans `src/server-setup.ts`, `src/index.ts` et `src/tools/*.ts`.
- **§5 `package.json:69`** — ligne confirmée ; la question qu'elle posait est désormais résolue
  (voir ci-dessus).

**Lignes vérifiées exactes (aucune correction nécessaire) :** `src/server-setup.ts:207`
(`export function createMcpServer(`, fichier de 250 lignes) · `src/tools/status-tools.ts:32`
(`server.tool(` puis `"coordinator_status"`) · `cli/channel.ts:37` et `:536`
(`StdioServerTransport`) · `dashboard/public/dashboard.js:647` (`new EventSource(...
/api/events)`) · les « 7 endpoints `/api/*` » hors `/api/events` sont bien au nombre de 7
(`threads-active`, `hot-files`, `quota`, `quota/refresh`, `reset`, `run-config`,
`scoring-stats`) · `cli/dashboard.ts` spawn bien le navigateur sur
`http://localhost:<port>/dashboard`.

**Marqueurs `(à vérifier)` restants :** aucun. Le seul marqueur de la fiche (§2, forme de l'API
SDK) a été tranché par inspection de `node_modules/@modelcontextprotocol/sdk@1.30.0`.

**Testabilité :** ⚠️ partielle

Testable ici et maintenant : toute la **moitié serveur**. On peut, avec le seul repo + Node 22 +
pnpm, enregistrer une ressource `ui://coordinator/status` en `text/html;profile=mcp-app` via
`registerResource`, migrer `coordinator_status` de `server.tool` vers `registerTool` et y poser
`_meta.ui.resourceUri`, puis vérifier la sortie brute par un `tools/list` + `resources/read` sur
le transport stdio — sans aucun hôte, sans credential.

Non testable ici : le **rendu** et tout ce qui en dépend (propagation des claims JWT dans
l'iframe, faisabilité de `_meta.ui.csp` vers l'origine du daemon, conservation du push temps
réel). Le blocage est nommé : Claude Code — le seul hôte garanti présent sur ce poste — n'est pas
dans la matrice de support. Il faut un hôte tiers (Claude Desktop, MCPJam, ou l'exemple
`basic-host` de `modelcontextprotocol/ext-apps` lancé en local), dont aucun n'est acquis dans
l'environnement de travail actuel.

---

## 1. Ce que c'est

MCP Apps est une extension officielle du protocole MCP qui permet à un serveur de livrer une interface HTML interactive rendue par l'hôte **dans la conversation**, au moment où l'agent appelle un outil. Le serveur expose des ressources sous le schéma d'URI `ui://` avec le mimeType `text/html;profile=mcp-app` (HTML + JS + CSS auto-contenus, pas de bundler imposé), et lie un outil à son interface via `_meta.ui.resourceUri` posé sur la définition de l'outil. Comme le lien est déclaré dans la description de l'outil, l'hôte peut précharger, cacher et auditer la ressource avant toute exécution. Le rendu se fait dans une iframe sandboxée obligatoire ; l'app reparle à l'hôte via un dialecte JSON-RPC transporté par `postMessage`, dont la plupart des méthodes sont nouvelles et préfixées `ui/` (`ui/initialize`), quelques-unes seulement étant partagées avec le core MCP (`tools/call`). L'app peut donc rappeler les outils du serveur, mais c'est l'hôte qui arbitre et qui applique le consentement — ce n'est pas littéralement le même chemin que l'appel d'outil direct, contrairement à ce qu'affirmait une des fiches sources. Le `_meta.ui` de la ressource porte en plus `csp` (origines externes autorisées) et `permissions` (micro, caméra…) ; le `csp` signifie qu'une app **peut** charger du code externe, donc l'argument « tout est pré-audité » est à nuancer. La négociation se fait par l'identifiant d'extension `io.modelcontextprotocol/ui`, annoncé côté client dans ses capabilities et côté serveur dans la réponse `server/discover`.

**Réserve décisive :** la matrice de support officielle liste Claude (web), Claude Desktop, VS Code GitHub Copilot, Microsoft 365 Copilot, Goose, Postman, MCPJam, ChatGPT, Cursor, Archestra.AI, PostHog Code. **Claude Code n'y figure pas.** Les trois chercheurs sont d'accord sur la liste ; l'un d'eux écrivait initialement que l'UI s'afficherait « dans Claude Code », ce que le vérificateur a explicitement infirmé.

## 2. Surface d'API exacte

```
io.modelcontextprotocol/ui              # identifiant d'extension (clé de négociation)
ui://                                   # schéma d'URI des ressources UI
text/html;profile=mcp-app               # mimeType de la ressource UI
_meta.ui.resourceUri: string            # sur la DÉFINITION D'OUTIL → lie l'outil à son UI
_meta.ui.visibility?: ("model"|"app")[] # sur la définition d'outil
_meta.ui.csp                            # sur la RESSOURCE UI : objet, PAS une liste d'origines
  .connectDomains?: string[]            #   origines des requêtes réseau
  .resourceDomains?: string[]           #   origines des ressources statiques
  .frameDomains?: string[]              #   origines des iframes imbriquées
  .baseUriDomains?: string[]            #   base URIs autorisées
_meta.ui.permissions                    # sur la ressource UI : objet
  .camera? .microphone? .geolocation? .clipboardWrite?   # chacun un objet vide `{}`
_meta.ui.domain?: string                # sur la ressource UI : origine de sandbox dédiée
_meta.ui.prefersBorder?: boolean        # sur la ressource UI : préférence de bordure visuelle
tools/call                              # méthode partagée avec le core MCP
@modelcontextprotocol/ext-apps          # npm : classe `App` (côté app, optionnelle), module `AppBridge` (côté hôte)
```

Méthodes du dialecte `ui/` (transport `postMessage`), telles que listées par la spec `2026-01-26` :

```
ui/initialize · ui/notifications/initialized              # handshake
ui/open-link · ui/message                                 # app → hôte
ui/request-display-mode · ui/update-model-context         # app → hôte
ui/notifications/tool-input · .../tool-input-partial      # hôte → app
ui/notifications/tool-result · .../tool-cancelled         # hôte → app
ui/notifications/size-changed · .../host-context-changed  # hôte → app
ui/resource-teardown                                      # hôte → app
```

Négociation, côté client :

```json
{ "_meta": { "io.modelcontextprotocol/clientCapabilities": {
  "extensions": { "io.modelcontextprotocol/ui": { "mimeTypes": ["text/html;profile=mcp-app"] } } } } }
```

Côté serveur, l'extension est annoncée dans la réponse `server/discover` sous `capabilities.extensions["io.modelcontextprotocol/ui"]`.

**Forme exacte côté SDK TypeScript — vérifié le 2026-08-14.** Le repo déclare `^1.29.0`
(`package.json:69`) et résout sur `@modelcontextprotocol/sdk@1.30.0`. Deux faits :

```ts
// node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts
registerTool(name: string, config: {
  title?: string; description?: string;
  inputSchema?: InputArgs; outputSchema?: OutputArgs;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;        // ← le slot où poser { ui: { resourceUri } }
}, cb): RegisteredTool;

registerResource(name: string, uriOrTemplate: string, config: ResourceMetadata, cb);
// ResourceMetadata = Omit<Resource, 'uri' | 'name'> → porte `mimeType` et `_meta`.
// `uriOrTemplate` est une string libre : `ui://coordinator/status` passe.
```

Conséquence : **`@modelcontextprotocol/ext-apps` n'est pas requis côté serveur** — le SDK core
installé suffit à émettre `_meta.ui`. Piège en revanche : le repo enregistre tous ses outils via
la surcharge **dépréciée** `server.tool(name, description, paramsSchema, annotations, cb)`
(ex. `src/tools/status-tools.ts:32`), qui n'expose **aucun** paramètre `_meta`. Poser
`_meta.ui.resourceUri` impose donc de migrer l'outil concerné vers `registerTool`.

## 3. Sources

- https://modelcontextprotocol.io/extensions/apps/overview
- https://modelcontextprotocol.io/extensions/client-matrix
- https://modelcontextprotocol.io/docs/extensions/overview
- https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
- https://apps.extensions.modelcontextprotocol.io/api/
- https://blog.modelcontextprotocol.io/posts/2025-11-21-mcp-apps/
- https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/
- https://blog.modelcontextprotocol.io/posts/2026-07-28/

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :** le dashboard existant est déjà exactement le bon artefact — du vanilla JS auto-contenu (`dashboard/public/index.html`, `dashboard/public/dashboard.js`, ~64 Ko au total dont ~48 Ko pour `dashboard.js`, sans bundler). Le reporter en ressource `ui://` supprimerait : le service de fichiers statiques dans `src/serve-http.ts` (routage `/dashboard`, `safeJoinUnderRoot`, en-têtes CSP dédiés, ~80 lignes), la commande `cli/dashboard.ts` qui ouvre un navigateur, et l'aller-retour « lance le serveur, ouvre `localhost:3100/dashboard` » qui est le vrai problème de découvrabilité du dashboard aujourd'hui. La capacité qui apparaît : quand un agent appelle `coordinator_status` (`src/tools/status-tools.ts:32`), la carte des agents actifs, les fichiers en cours et la matrice de conflits s'affichent en ligne, cliquables, avec la possibilité de rappeler les outils du daemon depuis l'UI. Bénéficiaire réel : l'utilisateur Claude Desktop / Cursor / VS Code Copilot, pas l'utilisateur Claude Code CLI, qui reste le profil d'usage principal du projet.

**Risque si on ne fait rien :** faible. Le dashboard HTTP continue de fonctionner ; le seul coût est de rester sur un mode de consultation hors-conversation, et de laisser à la concurrence l'affichage in-chat de l'état de coordination.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/server-setup.ts` (`createMcpServer`, l. 207-250) | Point unique où les 26 outils sont enregistrés via `register*Tools`. C'est ici qu'il faudrait annoncer la capability `io.modelcontextprotocol/ui` et enregistrer les ressources `ui://`. |
| `src/tools/status-tools.ts` (l. 32, `coordinator_status`) | Premier candidat pour porter `_meta.ui.resourceUri` : sa sortie est déjà une vue d'état agrégée. |
| `src/tools/agents-tools.ts`, `src/tools/files-tools.ts`, `src/tools/dependencies-tools.ts` | Candidats secondaires (agents actifs, fichiers chauds, graphe de dépendances) si on va au-delà d'une seule app. |
| `src/serve-http.ts` (l. 583-666) | Sert `/dashboard` depuis `dashboard/public/` avec CSP et anti-traversal dédiés (`safeJoinUnderRoot`, importé l. 29 ; `getDashboardDir` l. 66-76 ; en-têtes CSP l. 655-660) ; c'est le code qui disparaîtrait, ou qui devrait cohabiter. |
| `src/serve-http.ts` + `src/sse-emitter.ts` | Le dashboard consomme `/api/events` en `EventSource` (`dashboard.js:647`) et 7 endpoints `/api/*`. Une app `ui://` en iframe sandboxée n'a pas ce canal : il faut soit repasser par `tools/call`, soit autoriser l'origine via `_meta.ui.csp`. C'est le vrai coût de portage. |
| `dashboard/public/index.html`, `dashboard/public/dashboard.js` | L'artefact à convertir en ressource `ui://` auto-contenue (aujourd'hui : HTML + JS séparés, avec `COORDINATOR_URL` en dur côté client). |
| `cli/dashboard.ts` | Commande `dashboard` qui spawn le navigateur sur `http://localhost:<port>/dashboard` ; devient redondante si l'UI est in-chat. |
| `cli/channel.ts` (l. 37, 536 — `StdioServerTransport`) | Le serveur MCP stdio des Channels : deuxième surface où une app `ui://` pourrait être exposée, et surface la plus proche de Claude Code. |
| `package.json` (l. 69, `@modelcontextprotocol/sdk@^1.29.0`) | **Résolu (2026-08-14).** Résout sur `1.30.0`, qui expose bien `_meta` via `registerTool` et accepte une URI `ui://` via `registerResource`. `@modelcontextprotocol/ext-apps` n'est pas nécessaire côté serveur. Le vrai travail est de migrer les outils de la surcharge dépréciée `server.tool(...)` vers `registerTool(...)`. |
| `src/server-setup.ts` + `src/tools/*.ts` (`getSessionClaims`) | Si l'app rappelle les outils via l'hôte, l'auth par claims doit rester cohérente. `getSessionClaims` est threadé depuis `createMcpServer` vers chaque `register*Tools` et lu dans chaque handler (`status-tools.ts:38`). *(Corrigé : la fiche imputait ce point à `sdk/src/client.ts`, qui ne contient ni `getSessionClaims` ni `claims` — c'est le client HTTP SDK, dédié au flux OAuth et au refresh de tokens.)* |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Vu que Claude Code n'est pas dans la matrice de support MCP Apps, porter `dashboard/public/` en ressource `ui://` sert-il un utilisateur réel de mcp-coordinator aujourd'hui — ou faut-il attendre que Claude Code apparaisse dans la matrice, et n'investir d'ici là que dans le découplage du dashboard de `/api/*` (qui bénéficierait aux deux chemins) ?

### 6.2 Hypothèse

**Pré-enregistré le 2026-08-15, avant toute exécution.**

**Hypothèse.** La moitié serveur est triviale (le SDK 1.30.0 installé suffit, §0 l'a tranché) et
va marcher du premier coup. Le verdict ne se jouera donc pas là, mais sur deux points :
(a) est-ce que le client dominant du projet — Claude Code — peut *rendre* une app, et
(b) est-ce que le portage du dashboard est un **remplacement** de code maison (ce que dit la
nature `replace-homemade-code` de la fiche) ou un **ajout** d'une deuxième surface.

Je m'attends à `reporter`. Ce qui me ferait changer d'avis : une preuve exécutée que Claude Code
rend l'app, ou que le portage supprime réellement du code.

**Critères de refus — pré-enregistrés.** Je conclus « non bénéfique maintenant » si **l'un** de
ces résultats tombe :

| # | Critère de mort | Mesure |
|---|---|---|
| **R1** | Claude Code ne négocie pas l'extension `io.modelcontextprotocol/ui` **sur le fil** (pas seulement « absent de la matrice ») | Capture de l'`initialize` + du `_meta` des requêtes d'une vraie session Claude Code 2.1.233 vers un serveur qui déclare l'extension. Si aucune mention de `io.modelcontextprotocol/ui`, R1 est atteint. |
| **R2** | Le portage **ajoute** une surface au lieu d'en retirer une : il faut soit réécrire ≥ 5 des 8 appels de données en `tools/call` (perte du push SSE, argument produit), soit rouvrir `_meta.ui.csp.connectDomains` vers l'origine du daemon — donc garder le port HTTP qu'on prétendait supprimer | Décompte fichier par fichier des `fetch`/`EventSource` de `dashboard.js`, et vérification que `serve-http.ts` l.583-666 + `cli/dashboard.ts` peuvent réellement disparaître (admin\*.html reste servi en HTTP → ils ne peuvent pas). |
| **R3** | Les claims org (`getSessionClaims`) ne sont pas démontrables dans l'iframe → le dashboard in-chat afficherait une org fausse ou vide | Preuve documentaire de premier niveau (spec `2026-01-26`) : y a-t-il une propagation d'identité définie ? Sinon R3 est atteint par absence. |
| **R4** | Le chantier touche **plus de 10 fichiers** du dépôt | Décompte depuis §5 + ce que le PoC révèle. |

**Critères d'adoption** — il faut **les trois** : (A1) un hôte que l'utilisateur réel du projet
possède rend l'app ; (A2) le portage conserve le temps réel **sans** rouvrir l'origine HTTP du
daemon ; (A3) ≤ 10 fichiers touchés.

### 6.3 Protocole de vérification

**Amendé le 2026-08-15.** La veille supposait qu'aucun hôte n'était acquis. Deux corrections :
`examples/basic-host` du dépôt `ext-apps` est clonable et lançable en local, et le dépôt publie
un plugin Claude Code — dont il faut établir s'il **rend** les apps ou s'il ne fait que les
**écrire**. Le protocole devient :

- [x] Relire la matrice de support à la date du challenge, ligne par ligne. *(fait, §6.4-A)*
- [x] Établir la nature du plugin Claude Code `mcp-apps@modelcontextprotocol-ext-apps` :
      hôte de rendu, ou outillage d'auteur ? *(fait, §6.4-B)*
- [x] PoC serveur exécuté : ressource `ui://` + `_meta.ui.resourceUri` via `registerTool`,
      vérifiés par un vrai client MCP sur stdio. *(fait, §6.4-C)*
- [x] **Mesure sur le fil** : brancher Claude Code 2.1.233 sur le PoC et capturer ce qu'il
      déclare et ce qu'il demande. *(fait, §6.4-D)* ← c'est le test de R1
- [x] Décompte du coût de portage réel des 8 appels de données. *(fait, §6.4-E)*
- [ ] Rendu dans un hôte de la matrice : non exécuté, blocage nommé en §6.4-F.

> ⚠️ Les étapes de rendu (PoC affiché, portage des flux, claims dans l'iframe) ne sont pas exécutables sur ce poste : Claude Code n'est pas un hôte MCP Apps, et aucun hôte de la matrice (Claude Desktop, MCPJam, `basic-host`) n'est acquis dans l'environnement. Seule la moitié serveur — enregistrer la ressource `ui://` et poser `_meta.ui` — se teste en local.

- [ ] Relire la matrice de support à la date du challenge et vérifier ligne par ligne si Claude Code (CLI) y est apparu ; capturer la page.
- [ ] Vérifier dans `node_modules/@modelcontextprotocol/sdk@1.29.0` si `server.tool(...)` accepte un `_meta` arbitraire sur la définition d'outil, et si `server.resource(...)` accepte une URI `ui://` avec mimeType `text/html;profile=mcp-app`.
- [ ] PoC minimal : une ressource `ui://coordinator/status` rendant une page statique, liée à `coordinator_status` via `_meta.ui.resourceUri` ; brancher Claude Desktop sur le coordinateur en stdio et vérifier que l'UI s'affiche.
- [ ] Mesurer ce que coûte le portage réel : lister les 8 appels `fetch`/`EventSource` de `dashboard/public/dashboard.js` et déterminer pour chacun s'il devient un `tools/call` ou s'il exige un `_meta.ui.csp` pointant sur l'origine du daemon.
- [ ] Vérifier qu'une app en iframe sandboxée peut porter le JWT / les claims de l'appelant, sinon l'affichage multi-org est faux ou vide.

### 6.4 Résultat observé

> **Frontière exécuté / lu.** A, B, F = doc fetchée le 2026-08-15. C, D = **exécuté** sur ce poste
> (Node 22.21.0, Windows 11, SDK `@modelcontextprotocol/sdk@1.30.0` du dépôt, Claude Code 2.1.233).
> E = code lu dans le dépôt. Le **rendu** n'a pas été exécuté — blocage nommé en F.

#### A. La matrice de support, relue le 2026-08-15 — inchangée

`https://modelcontextprotocol.io/extensions/client-matrix`, fetchée le 2026-08-15. Les 11 hôtes
cochés pour MCP Apps sont **exactement** ceux de la fiche : Claude (web), Claude Desktop, VS Code
GitHub Copilot, Microsoft 365 Copilot, Goose, Postman, MCPJam, ChatGPT, Cursor, Archestra.AI,
PostHog Code. **Claude Code n'y figure toujours pas.** §0 tient, un jour plus tard.

#### B. Le plugin Claude Code de `ext-apps` n'est pas un moteur de rendu

Une recherche remontait « Claude Code can install MCP Apps via the plugin marketplace » — ce qui,
si c'était un hôte, renversait la fiche. Vérification en source de premier niveau, dépôt cloné :

```
$ cat ext-apps/plugins/mcp-apps/.claude-plugin/plugin.json
{
  "name": "mcp-apps",
  "version": "0.1.0",
  "description": "Claude Code skill for building MCP Apps with interactive UIs",
  ...
}
```

Et le README du dépôt : « There's no _supported_ host implementation in this repo (beyond the
examples/basic-host example) ». Le plugin est de l'**outillage d'auteur** (une skill pour écrire
et migrer des apps), pas un renderer. **La réserve de la fiche n'est pas contournable par un
plugin.**

#### C. La moitié serveur marche du premier coup — §0 confirmée par l'exécution

PoC jetable (`scratchpad/a08/poc-server.mjs`) : ressource `ui://coordinator/status` en
`text/html;profile=mcp-app` via `registerResource`, outil `poc_status` via `registerTool` portant
`_meta.ui.resourceUri`, plus un outil témoin `poc_legacy` enregistré via la surcharge dépréciée
`server.tool()`. Interrogé par un vrai client MCP du SDK sur stdio. Sortie brute :

```
=== serverVersion / protocol negotiated ===
{"name":"a08-poc","version":"0.0.1"} caps= {"resources":{"listChanged":true},"tools":{"listChanged":true}}

=== tools/list (brut) ===
    { "name": "poc_status", ..., "_meta": { "ui": {
        "resourceUri": "ui://coordinator/status", "visibility": ["model","app"] } } },
    { "name": "poc_legacy", "description": "Outil témoin sans _meta", ... }   ← aucun _meta

=== resources/list (brut) ===
    { "uri": "ui://coordinator/status", "mimeType": "text/html;profile=mcp-app",
      "_meta": { "ui": { "csp": { "connectDomains": ["http://127.0.0.1:3100"], ... },
                         "permissions": {}, "prefersBorder": true } } }

=== resources/read ui://coordinator/status (brut) ===
    { "contents": [ { "uri": "ui://coordinator/status",
                      "mimeType": "text/html;profile=mcp-app", "text": "<!doctype html>…" } ] }
```

**Confirmé :** le SDK 1.30.0 déjà installé suffit, `@modelcontextprotocol/ext-apps` n'est pas
requis côté serveur, et la migration `server.tool()` → `registerTool()` est bien le seul prix
d'entrée (le témoin `poc_legacy` sort sans `_meta`, comme prévu). **La moitié serveur n'est pas le
problème — et c'est précisément pour ça qu'elle ne peut pas porter le verdict.**

#### D. R1 — ATTEINT. Claude Code 2.1.233 n'a pas le code MCP Apps (et le fil seul ne suffisait pas à le prouver)

Le PoC branché sur Claude Code via `--mcp-config`, session `claude -p` appelant l'outil. **Log
intégral** du trafic JSON-RPC (`>>>` = client → serveur) :

```
>>> {"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{"roots":{"listChanged":true},"elicitation":{}},"clientInfo":{"name":"claude-code","title":"Claude Code","version":"2.1.233",…}},"jsonrpc":"2.0","id":0}
>>> {"method":"notifications/initialized","jsonrpc":"2.0"}
>>> {"method":"tools/list","jsonrpc":"2.0","id":1}
>>> {"method":"resources/list","jsonrpc":"2.0","id":2}
>>> {"method":"tools/call","params":{"name":"poc_status","arguments":{},"_meta":{"claudecode/toolUseId":"toolu_014qr2Vyk9gMnxXH9iKN3TrB","progressToken":3}},"jsonrpc":"2.0","id":3}
<<< {"result":{"content":[{"type":"text","text":"{\"agents_online\":2}"}]},"jsonrpc":"2.0","id":3}
```

Décompte sur le log complet : `io.modelcontextprotocol/clientCapabilities` → **0 occurrence**.
`io.modelcontextprotocol/ui` → **0 occurrence**. `resources/read` → **0 occurrence**.

> ⚠️ **Auto-correction — l'inférence évidente est fausse, et il faut le dire.** Conclure « pas de
> `clientCapabilities` dans le log ⇒ pas de support » **ne vaut pas comme preuve**. La spec
> (`extensions/overview`) place l'annonce d'extension dans le `_meta` de chaque requête, et cette
> enveloppe **n'est émise que dans l'ère `2026-07-28`** : en `2025-11-25`, qui est l'ère négociée
> ici, elle est vide par conception. Le log est donc compatible avec un client qui supporterait
> MCP Apps sans pouvoir le déclarer. La preuve valide est ailleurs — voir ci-dessous.

**Preuve de remplacement : le binaire lui-même.** Scan de `C:\Users\gagno\.local\bin\claude.exe`
(305,6 Mo, Claude Code 2.1.233), sortie brute :

```
claude.exe 2.1.233 — occurrences:
     0 io.modelcontextprotocol/ui
     0 ui://
     0 profile=mcp-app
     0 resourceUri
     0 ui/initialize
     0 prefersBorder
     6 io.modelcontextprotocol/clientCapabilities
    59 server/discover
    45 2026-07-28
    85 elicitation/create
```

C'est décisif **parce que les deux moitiés sont dans la même sortie** : la machinerie de
négociation d'extension existe bel et bien (`clientCapabilities` ×6, `server/discover` ×59,
`2026-07-28` ×45 — Claude Code sait faire), et **aucun** des sept marqueurs du vocabulaire MCP
Apps n'existe. Même en forçant l'ère `2026-07-28`, ce binaire ne pourrait ni déclarer l'extension,
ni lire `_meta.ui.resourceUri`, ni ouvrir un handshake `ui/initialize`. Ce n'est pas une ère
défavorable, c'est une absence de code.

Trois faits comportementaux, tous mesurés, qui recoupent le scan :
1. Claude Code sait poser du `_meta` sur `tools/call` — il y met `claudecode/toolUseId` et
   `progressToken`, du `_meta` **propriétaire**. Le canal n'est donc pas le problème.
2. Claude Code **liste** la ressource `ui://` (`resources/list`) mais ne la **lit jamais**. Il a
   reçu `_meta.ui.resourceUri` sur `poc_status` et l'a **ignoré** : il a rendu le `content` texte.
3. Effet de bord non anticipé par la fiche : la ressource `ui://` **apparaît dans le catalogue de
   ressources** de Claude Code. Une ressource dont le corps est le dashboard inliné (~64 Ko) y
   devient une ressource attachable, lisible **comme du texte** — donc un risque de pollution de
   contexte, à l'exact opposé de l'objectif de [`C06`](C06-tool-search-defer-loading.md). (Ce coût
   est proportionnel à la taille de l'app : quasi nul pour l'app minimale de §7.2.)

**Signal avancé à surveiller.** Le jour où Claude Code négocie `2026-07-28` avec le daemon, le
`_meta.clientCapabilities` deviendra observable et le même PoC répondra à la question en une
commande. C'est le test de réveil le moins cher qui existe pour cette fiche.

#### E. R2 — ATTEINT. Le portage ajoute une surface, il n'en retire aucune

Décompte exact des appels réseau de l'artefact (`grep` sur `dashboard/public/`) :

```
dashboard/public/dashboard.js:516  fetch(`${COORDINATOR_URL}/api/threads-active`, {   (POST)
dashboard/public/dashboard.js:647  new EventSource(`${COORDINATOR_URL}/api/events`)   (SSE)
dashboard/public/dashboard.js:665  fetch(`${COORDINATOR_URL}/api/hot-files`, {        (POST)
dashboard/public/dashboard.js:732  fetch(`${COORDINATOR_URL}/api/quota`)
dashboard/public/dashboard.js:744  fetch(`${COORDINATOR_URL}/health`)
dashboard/public/dashboard.js:765  fetch(`${COORDINATOR_URL}/api/quota/refresh`, { method: 'POST' })
dashboard/public/dashboard.js:801  fetch(`${COORDINATOR_URL}/api/reset`, { method: 'POST', … })
dashboard/public/dashboard.js:976  fetch(`${COORDINATOR_URL}/api/run-config`)
dashboard/public/dashboard.js:980  fetch(`${COORDINATOR_URL}/api/scoring-stats?since=24h`)
dashboard/public/admin-common.js:107  fetch(url, {                                    (pages admin)
```

**9 appels** dans `dashboard.js` (la fiche en annonçait 8). Confrontés aux 26 outils MCP réels —
`register_agent list_agents heartbeat agent_activity` · `announce_work post_to_thread
propose_resolution approve_resolution contest_resolution close_thread cancel_thread get_thread
get_thread_updates list_threads log_action_summary` · `set_dependency_map get_blast_radius
get_module_info` · `hot_files get_session_files check_file_conflict` · `wait_for_message
get_queued_messages mqtt_publish` · `coordinator_status wait_for_peers` :

| Appel du dashboard | Outil MCP équivalent |
|---|---|
| `/api/threads-active` | `list_threads` ✅ |
| `/api/hot-files` | `hot_files` ✅ |
| `/api/events` (SSE) | **aucun** — le push n'a pas d'équivalent `tools/call` |
| `/api/quota` · `/api/quota/refresh` | **aucun** |
| `/health` | **aucun** |
| `/api/reset` | **aucun** |
| `/api/run-config` | **aucun** |
| `/api/scoring-stats` | **aucun** |

**2 sur 9.** R2 était pré-enregistré comme un **OU** — et les deux branches sont ouvertes ; il
faut les chiffrer séparément, sans facturer la plus chère par défaut.

- **Branche A — tout réécrire en `tools/call`.** Impose 7 nouveaux outils MCP : la surface passe
  de 26 à ~33, ce qui **contredit frontalement** [`C06`](C06-tool-search-defer-loading.md) et
  [`A09`](A09-extensions-grouping-skills.md), dont tout le propos est de réduire cette surface.
  Et le push SSE n'a **aucun** équivalent `tools/call` : on perd le temps réel.
- **Branche B — ouvrir `_meta.ui.csp.connectDomains` vers l'origine du daemon.** Elle marche, et
  elle est même **bon marché**, vérifié dans le code : `COORDINATOR_AUTH_ENABLED` est faux par
  défaut (`serve-http.ts:101`), auquel cas `authenticateRequest` **injecte des claims
  synthétiques** (`auth.ts:519-525`, `sub: "legacy"`), et toutes les réponses JSON
  (`src/http/utils.ts:46`) comme le flux SSE (`serve-http.ts:352`) portent
  `Access-Control-Allow-Origin: *`. Une iframe à origine opaque peut donc exécuter `dashboard.js`
  **verbatim**, EventSource compris, sans créer un seul outil.

**Mais la branche B est précisément le second terme de R2**, et elle le déclenche : l'app iframe
tape le **port HTTP du daemon**, donc le serveur HTTP qu'on prétendait supprimer reste
indispensable. On obtient une iframe in-chat qui est un client HTTP de plus. **R2 est atteint par
la branche B, pas par la branche A** — la correction porte sur le raisonnement, pas sur le
résultat.

Et le code que la fiche promettait de supprimer ne peut pas l'être, pour **quatre** raisons
vérifiées, dont trois que ni la fiche ni ma première rédaction n'avaient nommées :

1. `src/serve-http.ts` l.583-666 sert aussi `admin.html`, `admin-orgs.html`, `admin-users.html` et
   leurs 5 JS/CSS, avec une branche CSP durcie dédiée (`isAdminAsset`, l.621-644). **La branche
   `/dashboard` reste, quoi qu'il arrive.**
2. `package.json` → `files: ["dist/src/","dist/cli/","dashboard/","LICENSE","README.md"]` :
   `dashboard/` est expédié dans le tarball npm. Soit on l'y garde (on ne retire rien), soit on
   inline 66 Ko dans un littéral TS avec une étape de build en plus.
3. Le raccourci « iframer `/dashboard` » est **verrouillé par le dépôt lui-même** :
   `serve-http.ts:656` pose `frame-ancestors 'none'` et l.658 `X-Frame-Options: DENY`.
4. La couverture e2e (`tests/e2e/dashboard.spec.ts`, Playwright) pilote un **navigateur**. Une app
   `ui://` n'a aucune histoire Playwright : le portage perd cette couverture ou exige un harnais
   neuf.

La nature `replace-homemade-code` de la fiche est donc **fausse** : on ajoute une deuxième surface
UI, on n'en retire aucune.

**Correction à la fiche :** §5 et §6.3 annoncent « les 8 appels `fetch`/`EventSource` » de
`dashboard.js`. Il y en a **9** — `/health` (l.744, qui alimente `#server-version` et le
`document.title`) manquait au décompte.

**Ce qui échappe à R2 — et c'est le seul chemin qui survit.** Une app **minimale** ne fait aucun
appel réseau : l'hôte lui pousse le résultat de l'outil via `ui/notifications/tool-result`
(§2). Une app qui se contente de rendre les 6 champs de `coordinator_status` ne déclenche
donc ni R2 (aucun `tools/call` nouveau, aucune CSP), ni R3 (aucune authentification propre : la
donnée arrive d'un appel d'outil déjà authentifié), ni R4 (2 fichiers : `src/server-setup.ts` +
`src/tools/status-tools.ts`, plus ~150 lignes de HTML). **C'est un « adopter partiellement »
techniquement viable** — il ne bute plus que sur R1. Voir §7.2.

#### F. R3 — atteint par absence. Rendu et claims : non exécutés, blocage nommé

Tentative réelle d'obtenir un hôte : `examples/basic-host` du dépôt `ext-apps` a été cloné et
`npm install` **a réussi** (575 paquets, exit 0). Mais son script de service est
`"serve": "bun --watch serve.ts"` :

```
$ bun --version
bash: bun: command not found
```

`bun` n'est pas installé sur ce poste, et l'hôte exige en plus un serveur MCP **HTTP** (`SERVERS`
= liste d'URL `/mcp`), pas le stdio du PoC. **Le rendu n'a donc pas été exécuté.** C'est la
frontière annoncée par §0 ; elle est confirmée, pas contournée.

Sur les claims : la doc `extensions/apps/overview` (fetchée le 2026-08-15) décrit l'isolation —
« The sandbox prevents your app from accessing the parent window's DOM, reading the host's cookies
or local storage » — et **ne définit aucune propagation d'identité** de la session MCP vers
l'iframe. Le projet fait pourtant transiter l'org par `getSessionClaims` dans **chaque** handler
(`src/tools/status-tools.ts:38` : `if (!claims) throw new Error("Session has no captured claims")`).
Pour qu'une app fetche `/api/*` directement, il faudrait lui donner un token — donc **inliner un
secret dans une ressource lisible dans la conversation**. R3 est atteint par absence de mécanisme,
et c'est un argument que §6.5 n'avait pas.

### 6.5 Contre-arguments

**Repris le 2026-08-15 après l'expérience.** Verdict par argument : ✅ renforcé · ➖ affaibli ·
🆕 révélé par l'expérience.

- ✅ **Le principal client cible n'est pas supporté — et ce n'est plus une lecture de matrice, c'est
  une mesure.** §6.4-D : Claude Code 2.1.233 déclare `{"roots":…,"elicitation":{}}`, zéro
  `extensions`, zéro `io.modelcontextprotocol/clientCapabilities`, et **ignore**
  `_meta.ui.resourceUri` qu'il a pourtant reçu. L'argument passe de « absent d'une matrice
  communautaire » à « refusé sur le fil ».
- ✅ **Le portage n'est pas cosmétique — chiffré.** §6.4-E : **2 appels sur 9** ont un équivalent
  parmi les 26 outils. Les 7 autres exigent de nouveaux outils MCP (26 → ~33), ce qui contredit
  directement [`C06`](C06-tool-search-defer-loading.md) et
  [`A09`](A09-extensions-grouping-skills.md). L'alternative CSP marche techniquement (`/api/*`
  répond `ACAO: *`) mais **conserve** le port HTTP.
- ✅ **On ne supprime pas le dashboard HTTP — vérifié dans le code.** `serve-http.ts:621-644` a une
  branche CSP durcie dédiée aux pages admin. Les ~80 lignes que la fiche promettait de supprimer
  **restent**, quoi qu'il arrive.
- ✅ **Auth et multi-org — aggravé.** La spec ne décrit aucune propagation d'identité vers
  l'iframe ; elle décrit l'inverse (isolation des cookies et du storage). Or le projet exige des
  claims dans **chaque** handler. Donner un token à l'app reviendrait à **inliner un secret dans
  une ressource lisible dans la conversation**.
- ➖ **Argument SOC 2 affaibli.** Il tient toujours sur le fond, mais il devient secondaire : on
  n'arrive jamais au stade où il compte.
- ✅ **YAGNI.** Renforcé par §6.4-D : le bénéficiaire qui reste (Cursor, VS Code Copilot, Claude
  Desktop) n'est pas le profil de déploiement observé du projet, et personne ne l'a demandé.
- 🆕 **Le plugin `mcp-apps` de `ext-apps` ne débloque rien.** C'est une skill d'auteur
  (`plugin.json` : « Claude Code skill for **building** MCP Apps »), pas un moteur de rendu. La
  piste la plus évidente de contournement est fermée.
- 🆕 **Effet de bord négatif, non anticipé : la ressource pollue le contexte.** §6.4-D : Claude
  Code appelle `resources/list` et **voit** la ressource `ui://`. Un dashboard inliné (~64 Ko)
  devient une ressource attachable, lisible comme du texte, par un client qui ne sait pas la
  rendre. Enregistrer la ressource « au cas où » a donc un **coût négatif** pour l'utilisateur
  principal, pas un coût nul.
- 🆕 **Maintenance à six mois.** L'artefact `dashboard.js` (47,9 Ko) devrait être inliné et
  maintenu en double : une version servie en HTTP (avec `COORDINATOR_URL`, les pages admin, la
  CSP `script-src 'self'`) et une version auto-contenue pour l'iframe. Deux artefacts qui
  divergent est le mode d'échec le plus prévisible de ce chantier.

---

## 7. Décision

| | |
|---|---|
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ✅ **reporter** · ⬜ refuser |
| **Date** | 2026-08-15 |
| **Justification** | Le client dominant du projet ne peut pas rendre d'app MCP : le binaire Claude Code 2.1.233 contient **0 occurrence** de `io.modelcontextprotocol/ui`, `ui://`, `resourceUri` et `ui/initialize`, alors qu'il contient toute la machinerie de négociation d'extension (§6.4-D). Le seul bénéficiaire que le projet revendique et qui soit dans la matrice — Cursor — se heurte aux deux mêmes murs : le portage **ajoute** une surface au lieu d'en retirer une (§6.4-E), et la spec ne définit **aucune** propagation de claims vers l'iframe (§6.4-F). |
| **Issue / PR** | Aucune ouverte pour A08. La couche ressources est renvoyée à **#281** (`coord://`) — voir §7.3. |
| **Jalon visé** | Aucun. Condition de réveil en §7.4. |

### 7.1 Ce que le challenge a corrigé dans la fiche

Quatre corrections, dont deux qui changent le classement :

| Champ | Avant | Après | Preuve |
|---|---|---|---|
| **Nature** | `replace-homemade-code` | **`opportunity`** | §6.4-E : la branche `/dashboard` reste (pages admin), `dashboard/` reste dans `package.json.files`, l'e2e Playwright n'a pas d'équivalent. On n'enlève rien. |
| **Tier** | 🟠 T2 | **🟡 T3** | Bloqué intégralement sur un tiers, sans bénéficiaire mesuré. « À suivre sans agir » est la définition du T3. |
| §5, §6.3 | « les 8 appels » | **9 appels** | `/health` (`dashboard.js:744`) manquait au décompte. |
| §6.5 « personne ne l'a demandé » | — | **reformulé** | Le projet revendique Cursor/Cline/Aider sur 9 surfaces (`README.md:7,46,158`, `cli/init.ts:306`, `docs/index.html:19,26,1641,2082,2471` + JSON-LD `:2551`). L'argument juste n'est pas « aucun bénéficiaire » mais « un seul de ces trois est dans la matrice, et R2/R3 le frappent aussi ». |

### 7.2 Pourquoi pas « adopter partiellement » — le sous-ensemble minimal est bon marché, et quand même inutile

C'est l'objection sérieuse, et elle a été instruite jusqu'au bout. Une app **minimale** — pas le
dashboard, juste les 6 champs de `coordinator_status`, alimentée par le
`ui/notifications/tool-result` que l'hôte pousse — échappe à **trois** des quatre critères de
mort : pas de `tools/call` nouveau ni de CSP (R2), pas d'authentification propre puisque la donnée
vient d'un appel d'outil déjà authentifié (R3), et un coût dérisoire (R4). La migration
`server.tool` → `registerTool` sur `coordinator_status` a été **appliquée puis révertée** :
**11 lignes, 1 fichier**, `tsc --noEmit` propre, **43 tests PASS / 0 FAIL** — parce que `tool()`
et `registerTool()` convergent tous deux sur `_createRegisteredTool`, la structure que les tests
inspectent.

**Donc R4 n'est pas atteint pour ce sous-ensemble, et il faut le dire.** Ce qui le tue est
ailleurs, et c'est une mesure, pas un principe :

- **R1 s'applique quand même**, et il est seul suffisant : Claude Code ignore `_meta.ui.resourceUri`
  (§6.4-D, `resources/read` → 0 occurrence).
- **Et le chantier a déjà un propriétaire, avec un consommateur mesuré.** L'issue **#281** (OPEN,
  ouverte par le mainteneur le 2026-08-15) instruit une couche de ressources `coord://` et mesure,
  session Claude Code réelle, `resources/read` → **1**. Claude Code **lit** les ressources
  `coord://`. Faire A08 en `ui://` reviendrait à dupliquer #281 avec le seul schéma d'URI dont on
  a la preuve mesurée qu'il est ignoré par le client dominant.

Adopter partiellement coûterait peu et rapporterait zéro à l'utilisateur observé, tout en
fragmentant un travail que #281 tient déjà.

### 7.3 Ce qu'il ne faut PAS faire, et ce qu'il faut faire tout de suite

**La question §6.1 propose « n'investir d'ici là que dans le découplage du dashboard de
`/api/*` ». C'est un mauvais cadrage : ce n'est pas du travail préparatoire à A08, c'est une
régression ouverte, et la conditionner à A08 l'enterre derrière une dépendance qu'elle n'a pas.**

```
dashboard/public/dashboard.js:1   const COORDINATOR_URL = 'http://localhost:3100';
src/serve-http.ts:656             …CSP: connect-src 'self'…
README.md:407                     "(or /dashboard on whichever port the coordinator is bound to)"
```

Sur tout port ≠ 3100, les 9 appels de la page partent en cross-origin et sont bloqués **par la CSP
que le daemon pose lui-même sur cette page** : le dashboard s'affiche vide, sans erreur visible.
`cli/dashboard.ts:14-19` montre que l'issue #69 a corrigé exactement cette classe de bug côté
*ouvreur* en laissant le côté *page* cassé, et `tests/e2e/dashboard.spec.ts:13-27` épingle
`PORT=3100` en nommant la cause — le bug est **intestable par construction**. Le correctif est déjà
la convention dans le même dossier (`admin-common.js:86` → `fetchJSON("/api/…")` en relatif). **À
faire maintenant, hors A08 → issue [#292](https://github.com/swoofer/mcp-coordinator/issues/292),
ouverte le 2026-08-15.**

Confirmé en runtime pendant ce challenge (daemon lancé sur `PORT=3199`) :

```
$ curl -s -D - http://localhost:3199/dashboard/dashboard.js
HTTP/1.1 200 OK
Content-Security-Policy: … connect-src 'self'; frame-ancestors 'none'; …

    const COORDINATOR_URL = 'http://localhost:3100';
```

### 7.4 Condition de réveil

Réveiller cette fiche si **l'un** de ces signaux apparaît :

1. **Le signal avancé, gratuit :** le jour où Claude Code négocie `2026-07-28` avec le daemon, son
   `_meta["io.modelcontextprotocol/clientCapabilities"]` devient observable. Le PoC de §6.4 répond
   alors à la question en une commande. (Le binaire 2.1.233 contient déjà `2026-07-28` ×45 et
   `server/discover` ×59 : la bascule peut arriver sans préavis.)
2. Claude Code apparaît dans `modelcontextprotocol.io/extensions/client-matrix`, **ou** le
   vocabulaire MCP Apps apparaît dans le binaire (re-lancer le scan de §6.4-D).
3. Un utilisateur réel sur un hôte de la matrice — en pratique **Cursor**, le seul des trois
   clients que le projet revendique qui y figure — demande le dashboard in-chat.

Réserve honnête à dater : Claude Code tourne aussi dans un panneau Claude Desktop
(`CLAUDE_CODE_ENTRYPOINT=claude-desktop` sur ce poste), surface qui **possède déjà** un moteur de
rendu iframe et **est** dans la matrice. C'est le chemin d'arrivée le plus plausible, et il rendrait
A08 réévaluable sans préavis. Le signal 1 le détectera.

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : `_meta.ui` précisé, SDK tranché (1.30.0 suffit), 3 erreurs repo corrigées. |
| 2026-08-15 | **Challenge — verdict `reporter`.** Moitié serveur exécutée et confirmée (ressource `ui://` + `_meta.ui.resourceUri` sortent bien du SDK 1.30.0). R1 atteint par scan du binaire Claude Code 2.1.233 : 0 occurrence du vocabulaire MCP Apps, alors que la machinerie d'extension y est (`clientCapabilities` ×6, `server/discover` ×59). R2 atteint par la branche CSP (le port HTTP reste requis), R3 par absence de propagation de claims dans la spec. Rendu **non exécuté** (`bun` absent pour `basic-host`). Corrections : nature → `opportunity`, tier T2 → T3, « 8 appels » → **9**. Trois réfutateurs adversariaux ont invalidé la **preuve** initiale de R1 (l'absence de `clientCapabilities` sur le fil s'explique par l'ère `2025-11-25`) et le raisonnement de R2 (le OU écrasé en son terme le plus cher) — les deux ont été réécrits. Renvoi de la couche ressources à **#281** (`coord://`, `resources/read` mesuré à 1). Bug indépendant sorti du périmètre : `dashboard.js:1` code en dur `localhost:3100` → issue **#292**. |
