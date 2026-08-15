# A08 — MCP Apps (`ui://`) : le dashboard rendu dans la conversation

| Champ | Valeur |
|---|---|
| **ID** | `mcp-apps-ui` |
| **Surface** | mcp-spec |
| **Statut** | Extension officielle, spec « Stable (2026-01-26) » — support hôte partiel (extension opt-in, désactivée par défaut ; « GA » n'est pas un label MCP) |
| **Disponible depuis** | Proposition SEP-1865 (blog 2025-11-21), spec `2026-01-26`, extension officielle référencée par la release core `2026-07-28` |
| **Tier** | T2-fort-levier |
| **Nature** | replace-homemade-code |
| **Effort estimé** | L |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — serveur testable en local, rendu exige un hôte tiers |
| **Statut du challenge** | ⬜ à faire |

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

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

<Proposition de la veille, non exécutée.>

> ⚠️ Les étapes de rendu (PoC affiché, portage des flux, claims dans l'iframe) ne sont pas exécutables sur ce poste : Claude Code n'est pas un hôte MCP Apps, et aucun hôte de la matrice (Claude Desktop, MCPJam, `basic-host`) n'est acquis dans l'environnement. Seule la moitié serveur — enregistrer la ressource `ui://` et poser `_meta.ui` — se teste en local.

- [ ] Relire la matrice de support à la date du challenge et vérifier ligne par ligne si Claude Code (CLI) y est apparu ; capturer la page.
- [ ] Vérifier dans `node_modules/@modelcontextprotocol/sdk@1.29.0` si `server.tool(...)` accepte un `_meta` arbitraire sur la définition d'outil, et si `server.resource(...)` accepte une URI `ui://` avec mimeType `text/html;profile=mcp-app`.
- [ ] PoC minimal : une ressource `ui://coordinator/status` rendant une page statique, liée à `coordinator_status` via `_meta.ui.resourceUri` ; brancher Claude Desktop sur le coordinateur en stdio et vérifier que l'UI s'affiche.
- [ ] Mesurer ce que coûte le portage réel : lister les 8 appels `fetch`/`EventSource` de `dashboard/public/dashboard.js` et déterminer pour chacun s'il devient un `tools/call` ou s'il exige un `_meta.ui.csp` pointant sur l'origine du daemon.
- [ ] Vérifier qu'une app en iframe sandboxée peut porter le JWT / les claims de l'appelant, sinon l'affichage multi-org est faux ou vide.

### 6.4 Résultat observé

<Non renseigné : rien n'a encore été testé.>

### 6.5 Contre-arguments

- **Le principal client cible n'est pas supporté.** Claude Code, qui est le mode d'usage dominant de mcp-coordinator, n'est pas dans la matrice officielle. Investir en L pour un rendu que l'utilisateur principal ne verra pas est difficile à justifier maintenant.
- **Le portage n'est pas cosmétique.** Le dashboard actuel vit de `EventSource` sur `/api/events` et de 7 endpoints REST. En iframe sandboxée, ce modèle disparaît : soit on réécrit tout le flux de données en `tools/call` (perte du push temps réel, qui est un argument produit du projet), soit on ouvre une CSP vers l'origine du daemon — et on retombe sur le port HTTP qu'on prétendait supprimer.
- **On ne supprime pas le dashboard HTTP pour autant.** L'auto-hébergeur, l'écran de supervision permanent et l'admin (`dashboard/public/admin*.html`) resteront servis en HTTP. On ajoute donc une deuxième surface UI à maintenir, on n'en retire pas une.
- **Auth et multi-org.** Le projet a une chaîne `getSessionClaims` / org-scoping (Phase 2, `src/auth/`). Rien dans la spec ne garantit que l'app iframe hérite proprement des claims de la session MCP ; un dashboard in-chat qui affiche l'org « default » serait une régression de sécurité perçue.
- **Argument SOC 2 affaibli.** Le « tout est pré-audité par l'hôte » ne tient qu'en l'absence de `_meta.ui.csp` ; dès qu'on ouvre des origines externes, l'argument s'inverse.
- **YAGNI.** Le vrai problème du dashboard est la découvrabilité, pas la technologie de rendu. Une ligne d'output d'outil avec l'URL cliquable règle 80 % du symptôme pour un effort S.

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
| 2026-08-14 | Vérification des faits : `_meta.ui` précisé, SDK tranché (1.30.0 suffit), 3 erreurs repo corrigées. |
