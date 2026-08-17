# E03 — Brancher mcp-coordinator sur CMA : mcp_toolset, custom tools, worker self-hosted

| Champ | Valeur |
|---|---|
| **ID** | `cma-integration-paths` |
| **Surface** | managed-agents · claude-api |
| **Statut** | beta (les 5 briques sont en beta ; aucune n'est GA) |
| **Disponible depuis** | `managed-agents-2026-04-01` ; header MCP connector `mcp-client-2025-11-20` |
| **Tier** | T2-fort-levier |
| **Nature** | integration |
| **Effort estimé** | S (mcp_toolset) · M (custom tools) · L (worker self-hosted) |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — pas de credentials CMA ni d'endpoint HTTPS public |
| **Statut du challenge** | ✅ **tranché** (2026-08-16) — `reporter` ; **K1 déclenché : l'affirmation centrale est réfutée par la doc**, E01 et E02 à corriger |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- **§2 (c) — limites d'API fausses.** La fiche annonçait « 60 rpm sur les environnements, 5 concurrents max ». La page `managed-agents/reference` documente en réalité **300 req/min sur les endpoints de création** (agents, sessions, environnements) et **1 200 req/min sur les endpoints de lecture**, par organisation. Aucune limite « 5 environnements concurrents » n'est documentée. Corrigé.
- **§2 (a) — marqueur `(à vérifier)` sur la forme de `configs` : tranché.** La divergence relevée entre les deux chercheurs est réelle et les deux formes sont exactes. Côté CMA, `configs` est bien un **tableau** d'objets `{ name, enabled, permission_policy }` (`managed-agents/mcp-connector`, section « Configure which MCP tools are available », même forme que `agent_toolset_20260401`). Côté Messages API, `configs` est bien un **objet indexé par nom d'outil** avec `{ enabled, defer_loading }` (`agents-and-tools/mcp-connector`). Le marqueur est remplacé par le fait établi.
- **§5 `src/serve-http.ts` — ligne CORS imprécise.** La l. 548 est l'en-tête `Access-Control-Allow-Headers` (`"Content-Type, mcp-session-id, Authorization"`), pas l'exposition. L'exposition de `mcp-session-id` se fait par `Access-Control-Expose-Headers` à la **l. 761**. Corrigé.

**Faits confirmés sans changement :**

- Header beta `managed-agents-2026-04-01` (et `agent-memory-2026-07-22` pour les memory stores) ; header Messages API `mcp-client-2025-11-20`, avec `mcp-client-2025-04-04` explicitement marqué déprécié. Statut **beta** confirmé sur les deux surfaces ; non éligible ZDR côté Messages API.
- `mcp_servers[]` : `type: "url"` uniquement, `name` unique 1–255 car., `url` ≤ 2 048 car., max 20 serveurs par agent, rejet des serveurs orphelins et des toolsets pendants, pas de secret dans `mcp_servers` (auth par `vault_ids` sur la session, appariement par `mcp_server_url` normalisée).
- Seuil de 100 000 caractères de sortie d'outil (≈ 25 000 tokens) → écriture dans un fichier du sandbox + aperçu tronqué. Confirmé sur `managed-agents/tools` et `managed-agents/mcp-connector`.
- Erreurs `mcp_connection_failed_error` / `mcp_authentication_failed_error` avec `mcp_server_name` et `retry_status` ; événements `agent.mcp_tool_use` / `agent.mcp_tool_result` (table des event types de `managed-agents/reference`).
- Custom tools : `type: "custom"` avec `name` / `description` / `input_schema` ; l'agent émet `agent.custom_tool_use`, la session passe en `session.status_idle` avec `stop_reason: requires_action` (les événements bloquants sont listés dans `stop_reason.event_ids`), le client répond `user.custom_tool_result` avec **`custom_tool_use_id`** — qui est bien l'**id de l'événement** bloquant, pas un `tool_use_id`. Confirmé.
- Worker self-hosted : `EnvironmentWorker` importé de `@anthropic-ai/sdk/helpers/beta/environments`, méthode `handleItem()` ; fabrique `tools: (ctx) => [...betaAgentToolset20260401(ctx), monTool]` (`betaAgentToolset20260401` vient de `@anthropic-ai/sdk/tools/agent-toolset/node`). Les 7 flags cités de `ant beta:worker` (`--environment-id`, `--environment-key`, `--workdir`, `--on-work`, `--unrestricted-paths`, `--max-idle`, `--log-format`) sont tous présents dans la table de `managed-agents/reference`, avec `--max-idle` à `60s` par défaut et `--workdir` à `.`. `ANTHROPIC_ENVIRONMENT_ID` / `ANTHROPIC_ENVIRONMENT_KEY` confirmés.
- Les deux trous cités : credentials `environment_variable` **non supportés** avec les sandboxes self-hosted (note explicite sur `managed-agents/vaults`) ; et « Serving custom tools requires the SDK worker: the `ant` CLI worker has no way to register a custom tool implementation ». Le pattern « wrap an MCP server as custom tools » est bien documenté.
- Environnements : `config.type` `cloud` | `self_hosted`, `networking.type` `unrestricted` | `limited` avec `allowed_hosts` (hostnames nus ou `*.example.com`, sans schéma ni port ni path), `allow_mcp_servers` et `allow_package_managers` par défaut à `false`, `packages` à 6 clés (`apt`, `cargo`, `gem`, `go`, `npm`, `pip`). **Les environnements ne sont pas versionnés** — confirmé.
- §5 : les 11 fichiers/modules cités existent tous. Les 6 modules de `src/tools/` totalisent bien **26** appels `server.tool(` (4 + 11 + 3 + 3 + 3 + 2). Lignes vérifiées : `serve-http.ts` l. 740 (route `/mcp`), l. 801 (`new StreamableHTTPServerTransport`), l. 239–256 (Bearer + `WWW-Authenticate: Bearer realm="mcp-coordinator"`), l. 328–330 (fallback `?token=`, GET seulement) ; `server-setup.ts` l. 233 (`io.github.swoofer/mcp-coordinator`) et l. 242–247 (les 6 `register*Tools`) ; `cli/channel.ts` l. 536 (`new StdioServerTransport()`). `consultation-tools.ts` fait bien 17,6 Ko.

**Marqueurs `(à vérifier)` restants :** aucun.

**Testabilité :** ⚠️ partielle
Testable ici et maintenant, sans compte Anthropic : la mesure du plafond de 100 000 caractères (point 2 du §6.3) — lancer le daemon local, peupler un registre à ~20 agents, appeler `list_agents` et les outils de `consultation-tools.ts` via un client MCP et mesurer la longueur des sorties ; ainsi que l'audit du fallback `?token=` de `src/serve-http.ts` (l. 328–330). Le point 3 (forme de `configs`) n'a plus besoin d'un appel réel : la doc tranche.
Non testable ici : les points 1, 4 et 5 du §6.3. Il manque une clé API Anthropic autorisée sur `managed-agents-2026-04-01` (création d'agent, de session, d'environnement, `environment_key` pour le worker) **et** un endpoint HTTPS du coordinateur publiquement joignable depuis l'infrastructure Anthropic — le profil de déploiement actuel est localhost + broker MQTT local.

---

## 1. Ce que c'est

Trois chemins distincts pour rendre les 26 outils MCP de mcp-coordinator appelables depuis Claude Managed Agents (CMA) et depuis la Messages API, sans passer par Claude Code.

**(a) MCP connector.** L'agent déclare `mcp_servers[]` — uniquement `type: "url"`, donc HTTPS, donc **aucun support stdio** — et chaque serveur déclaré doit avoir exactement un `mcp_toolset` correspondant dans `tools[]`. L'API rejette les serveurs orphelins comme les toolsets pendants. Le toolset porte un `default_config` + des `configs` par nom d'outil, ce qui donne une allowlist/denylist native : on peut n'exposer que 6 outils sur 26, ou couper toutes les écritures pour un agent observateur. Transport : streamable HTTP recommandé, fallback SSE automatique. Une sortie d'outil > 100 000 caractères est écrite dans un fichier du sandbox et le modèle ne voit qu'un aperçu tronqué avec le chemin. En multiagent, les serveurs MCP ne sont pas partagés : chaque agent redéclare les siens (max 20 par agent).

**(b) Custom tools exécutés côté client.** L'agent déclare des tools `type: "custom"` ; il émet `agent.custom_tool_use`, la session s'arrête en `stop_reason: requires_action` et attend **indéfiniment** un `user.custom_tool_result`. Le mapping MCP → custom est 1:1 sur `name` / `description` / `input_schema`. Pas de tunnel, pas d'endpoint public — mais les permission policies ne s'appliquent pas aux custom tools : c'est le client qui arbitre.

**(c) Sandbox self-hosted + EnvironmentWorker.** Un environnement `config.type: "self_hosted"` laisse l'orchestration chez Anthropic et déplace l'exécution des outils chez nous. Un worker (binaire `ant beta:worker` ou helper SDK `EnvironmentWorker`) réclame les work items et poste les résultats. La doc documente explicitement le pattern « wrap an MCP server as custom tools ». C'est le seul montage où un agent CMA et les agents Claude Code locaux partagent réellement le même checkout git.

**Contrainte transverse (cloud).** En `networking.type: "limited"` (recommandé en production), il faut soit `allow_mcp_servers: true`, soit lister le hostname du coordinateur/tunnel dans `allowed_hosts` (hostnames nus ou `*.example.com`, sans schéma ni port ni path).

## 2. Surface d'API exacte

**(a) MCP connector, côté CMA (agent-scoped, secrets via `vault_ids` sur la session) :**

```json
{
  "mcp_servers": [
    { "type": "url", "name": "mcp-coordinator", "url": "https://coord.example.com/mcp" }
  ],
  "tools": [
    { "type": "mcp_toolset",
      "mcp_server_name": "mcp-coordinator",
      "default_config": { "enabled": false, "permission_policy": "..." },
      "configs": [ { "name": "announce_work", "enabled": true, "permission_policy": "..." } ] }
  ]
}
```

Contraintes : `name` unique 1–255 car., `url` ≤ 2048 car., max 20 serveurs MCP par agent, pas de secret dans `mcp_servers`.
Erreurs `session.error` : `mcp_connection_failed_error`, `mcp_authentication_failed_error` (portent `mcp_server_name` et `retry_status`).
Événements : `agent.mcp_tool_use`, `agent.mcp_tool_result`.

**(a′) MCP connector, côté Messages API** — même nom de brique, **forme différente**, ne pas confondre :

```
header : anthropic-beta: mcp-client-2025-11-20   (mcp-client-2025-04-04 déprécié)
mcp_servers[] : { type: "url", url, name, authorization_token }
tools[]       : { type: "mcp_toolset", mcp_server_name,
                  default_config: { enabled, defer_loading },
                  configs: { "<tool_name>": { enabled, defer_loading } },
                  cache_control }
blocs réponse : mcp_tool_use (avec server_name) / mcp_tool_result
```

> **Divergence entre les deux chercheurs — tranchée le 2026-08-14 : les deux formes sont exactes.** Ce sont bien deux surfaces distinctes. Sur **CMA**, `configs` est un **tableau** d'objets `{name, enabled, permission_policy}` — même forme que `agent_toolset_20260401`, `name` étant le nom nu de l'outil tel que le serveur le rapporte (`managed-agents/mcp-connector`). Sur la **Messages API**, `configs` est un **objet indexé par nom d'outil** avec `{enabled, defer_loading}`, et `default_config` y porte `{enabled, defer_loading}` (`agents-and-tools/mcp-connector`). Aucune ambiguïté restante avant code. Non éligible ZDR côté Messages API.

**(b) Custom tools :**

```json
{ "tools": [ { "type": "custom", "name": "announce_work", "description": "...",
               "input_schema": { "type": "object", "properties": {}, "required": [] } } ] }
```
Réponse client : `{ "type": "user.custom_tool_result", "custom_tool_use_id": "...", "content": [{ "type": "text", "text": "..." }] }`.
`custom_tool_use_id` est un **id d'ÉVÉNEMENT**, pas le champ `id`. En multiagent, l'événement est reposté sur le thread primaire avec `session_thread_id`.

**(c) Environnement + worker :**

```
POST /v1/environments
{ "name": "...", "config": { "type": "cloud" | "self_hosted",
    "networking": { "type": "limited", "allowed_hosts": ["coord.example.com"],
                    "allow_mcp_servers": true, "allow_package_managers": false },
    "packages": { "apt": [], "cargo": [], "gem": [], "go": [], "npm": [], "pip": [] } } }
```
Limites (rate limits par organisation, `managed-agents/reference`) : **300 req/min** sur les endpoints de création (agents, sessions, environnements), **1 200 req/min** sur les endpoints de lecture (retrieve, list, stream). Aucune limite de concurrence d'environnements n'est documentée. Les environnements ne sont pas versionnés.
CLI : `ant beta:worker poll` / `ant beta:worker run` avec `--environment-id`, `--environment-key`, `--workdir`, `--on-work`, `--unrestricted-paths`, `--max-idle`, `--log-format`.
SDK : `import { EnvironmentWorker } from "@anthropic-ai/sdk/helpers/beta/environments"` ;
`new EnvironmentWorker({ client, environmentId, environmentKey, workdir, tools: (ctx) => [...betaAgentToolset20260401(ctx), monTool] })`, méthode `handleItem()`.
Env vars : `ANTHROPIC_ENVIRONMENT_ID`, `ANTHROPIC_ENVIRONMENT_KEY` (pas la clé API Claude). Endpoints `WorkQueueStats` / `StopWork`.
Limites connues : credentials `environment_variable` du vault non supportés avec les sandboxes self-hosted ; le CLI `ant` seul ne peut pas enregistrer d'implémentation de custom tool (il faut le worker SDK).

## 3. Sources

- https://platform.claude.com/docs/en/managed-agents/mcp-connector
- https://platform.claude.com/docs/en/managed-agents/reference
- https://platform.claude.com/docs/en/managed-agents/tools
- https://platform.claude.com/docs/en/managed-agents/events-and-streaming
- https://platform.claude.com/docs/en/managed-agents/permission-policies
- https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes
- https://platform.claude.com/docs/en/managed-agents/environments
- https://platform.claude.com/docs/en/managed-agents/vaults
- https://platform.claude.com/docs/en/agents-and-tools/mcp-connector
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :**
Le chemin (a) est quasi gratuit : `src/serve-http.ts` expose déjà `POST /mcp` en `StreamableHTTPServerTransport` avec auth Bearer (`Authorization: Bearer …`, `WWW-Authenticate: Bearer realm="mcp-coordinator"`). Il ne manque qu'un endpoint HTTPS joignable et une recette documentée. Capacité qui apparaît : un agent CMA piloté par la Messages API devient un **agent de première classe dans le registre** — il fait `register_agent`, `heartbeat`, `announce_work`, il est vu par `conflict-detector.ts` et apparaît dans le dashboard, exactement comme un Claude Code local. Aujourd'hui la coordination s'arrête à la frontière de Claude Code ; c'est ce qui la fait sauter. Les `configs` par outil donnent aussi, sans écrire une ligne, un mode lecture seule (couper `announce_work`, `register_agent`, les écritures de consultation) pour les agents observateurs — capacité qu'on aurait sinon dû construire dans `src/auth.ts` / `src/security/`.

Le chemin (c) est le seul qui fasse coordonner **les mêmes fichiers** : un worker self-hosted partage le checkout git, donc `file-tracker.ts` / `working-files-tracker.ts` / `conflict-detector.ts` voient les fichiers touchés par l'agent CMA. Sans lui, un agent CMA en sandbox cloud travaille sur une copie et la détection de conflit ne veut rien dire.

Aucun code ne disparaît : c'est une extension de surface, pas un remplacement.

**Risque si on ne fait rien :**
Faible mais réel. mcp-coordinator reste un outil « Claude Code local uniquement ». À mesure que des équipes déportent du travail sur des agents managés, la vue du registre devient partielle : le dashboard montre 3 agents alors que 5 touchent le repo, et `conflict-detector.ts` rend des verdicts faux par omission. La contrainte 100k caractères de sortie MCP est par ailleurs un plafond à vérifier sur `list_agents` / `get_status` en gros repo, indépendamment de CMA.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/serve-http.ts` | Déjà conforme : `StreamableHTTPServerTransport` sur `POST /mcp` (l. 740, 801), auth Bearer (l. 239–256), CORS acceptant `Content-Type, mcp-session-id, Authorization` (`Access-Control-Allow-Headers`, l. 548) et exposant `mcp-session-id` (`Access-Control-Expose-Headers`, l. 761). À vérifier : le fallback `?token=` (l. 328–330) n'a pas de sens pour CMA — seul le header doit compter. |
| `src/server-setup.ts` | Point d'enregistrement des 6 familles (l. 242–247) et du nom serveur `io.github.swoofer/mcp-coordinator` (l. 233). C'est ici qu'on brancherait un profil « surface réduite CMA ». |
| `src/tools/*.ts` (6 fichiers, 26 `server.tool(`) | Chaque `name` / `description` / schéma zod est ce qui sera recopié 1:1 en `type: "custom"` pour les chemins (b) et (c). Un export machine-lisible du catalogue manque aujourd'hui. |
| `src/tools/consultation-tools.ts` (17,6 Ko) | Le plus gros émetteur : candidat n°1 au dépassement des 100 000 caractères de sortie. À mesurer. |
| `src/tools/agents-tools.ts` | 4 outils (`register_agent`, `list_agents`, `heartbeat`, `agent_activity`) : le socle minimal d'une allowlist `configs` pour un agent CMA. |
| `cli/channel.ts` | Serveur MCP **stdio** (`StdioServerTransport`) : confirmé hors périmètre CMA, qui n'accepte que `type: "url"`. Reste réservé aux clients locaux. |
| `sdk/src/` (`client.ts`, `storage.ts`, `keytar-store.ts`, `profiles.ts`) | SDK d'auth/token (device code, refresh, keytar). Emplacement naturel d'un pont `EnvironmentWorker` ou d'un traducteur `tools/list` → déclarations `custom`, mais rien n'existe pour l'appel d'outils : à écrire. |
| `src/conflict-detector.ts`, `src/file-tracker.ts`, `src/working-files-tracker.ts` | Ne sont utiles à un agent CMA que si le sandbox est self-hosted et partage le checkout. En sandbox cloud, leurs verdicts sont vides de sens. |
| `docs/onboarding-self-host.md`, `docs/ARCHITECTURE.md`, `docs/openapi.yaml` | Où documenter la recette : HTTPS/tunnel, `allowed_hosts` vs `allow_mcp_servers`, allowlist `configs`. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Parmi les trois chemins, lequel mcp-coordinator supporte-t-il officiellement : le MCP connector seul (documenter une recette HTTPS + allowlist `configs`, zéro code), ou faut-il livrer un paquet `@mcp-coordinator/cma-worker` fondé sur `EnvironmentWorker` — seul montage où l'agent CMA partage le checkout et où `conflict-detector.ts` garde un sens — en acceptant d'ajouter une dépendance à `@anthropic-ai/sdk` en beta ?

### 6.2 Hypothèse

*Pré-enregistrée le 2026-08-16, **avant** toute exécution.*

> ⚠️ **Risque de circularité, signalé d'avance.** `E01` et `E02` ont toutes deux conclu en citant
> **cette fiche** — « le chemin (c) est le seul où l'agent CMA partage le checkout git ». Trois fiches
> qui se citent mutuellement peuvent fabriquer une certitude sans preuve. **Le premier travail de ce
> challenge est donc de vérifier que cette affirmation repose sur la documentation d'Anthropic et non
> sur un renvoi interne.** Si elle ne tient pas, `E01` et `E02` doivent être corrigées.

**Ce que je crois qu'il va se passer.**

1. L'affirmation « seul (c) partage le checkout » **tient**, parce qu'elle découle d'un fait simple :
   une sandbox cloud travaille sur une copie. Mais je dois la sourcer, pas la déduire.
2. Le plafond de 100 000 caractères sera **loin d'être atteint** — `C13` et `D05` ont mesuré que la
   base est vide, donc `list_agents` rend une liste vide.
3. Le chemin (a), MCP connector seul, coûte **zéro code** — `E01` l'a chiffré.

**Verdict pressenti :** `adopter partiellement` — documenter la recette (a), **reporter** le paquet
worker, et corriger §6.1 dont l'alternative est mal posée.

**Critères de mort.**

| # | Si… | …alors |
|---|---|---|
| **K1** | l'affirmation « seul (c) partage le checkout » n'est **pas sourçable** dans la doc d'Anthropic | c'est une circularité : `E01`, `E02` et cette fiche s'appuient sur du vide, et je dois les corriger toutes les trois. |
| **K2** | le plafond de 100 000 caractères est **atteignable** en usage réaliste | c'est un défaut à corriger indépendamment de CMA. |
| **K3** | livrer `@mcp-coordinator/cma-worker` coûte plus de **8 fichiers** | la branche worker est disqualifiée par le coût. |
| **K4** | ajouter `@anthropic-ai/sdk` en beta crée une dépendance que le projet ne peut pas tenir | `refuser` la branche worker, quel que soit son intérêt. |
| **K5** | aucun utilisateur n'a demandé une intégration CMA | filtre YAGNI — `E01` a déjà mesuré zéro demande. |

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

<Proposition de la veille, non exécutée.>

> ⚠️ Les points 1, 4 et 5 ne sont pas exécutables sur le poste : il manque une clé API Anthropic autorisée sur `managed-agents-2026-04-01` (agents, sessions, environnements, `environment_key`) et un endpoint HTTPS du coordinateur joignable depuis l'infrastructure Anthropic. Le point 3 est déjà tranché par la doc (voir §0). Restent exécutables localement : le point 2, et l'audit du fallback `?token=`.

- [ ] Exposer le daemon en HTTPS (tunnel), déclarer `mcp_servers` + `mcp_toolset` avec une allowlist des 4 outils de `agents-tools.ts`, et vérifier qu'un agent CMA apparaît bien dans `list_agents` et dans le dashboard.
- [ ] Mesurer la taille de sortie réelle de `consultation-tools.ts` (thread chargé) et de `list_agents` sur un registre à ~20 agents : dépasse-t-on les 100 000 caractères ?
- [ ] Vérifier la forme exacte de `configs` côté CMA (tableau `{name,…}` vs objet indexé) sur un appel réel — le bundle donne deux formes contradictoires.
- [ ] Tester le comportement en `networking: limited` sans `allow_mcp_servers` et sans `allowed_hosts` : quel message d'erreur remonte, et est-il diagnosticable depuis `cli/doctor.ts` ?
- [ ] PoC `EnvironmentWorker` : enregistrer 2 outils du coordinateur, lancer `ant beta:worker run`, confirmer qu'un agent CMA modifie un fichier du checkout local et que `file-tracker.ts` le voit.

### 6.4 Résultat observé

*Challenge du 2026-08-16.*

#### A. 🔴🔴 K1 SE DÉCLENCHE — l'affirmation centrale est **réfutée par la documentation**

§1(c), §4, §5 et §6.1 affirment que le chemin (c) est « **le seul montage où un agent CMA et les
agents Claude Code locaux partagent réellement le même checkout git** ». C'est **faux**, et la doc
d'Anthropic dit à peu près l'inverse. Récupérée et citée mot pour mot :

> « **Anthropic doesn't mount files or GitHub repositories into self-hosted sandboxes.** To make
> session-specific files available, pass file references (such as an S3 path or commit SHA) in the
> session `metadata` field […] then **stages the files into the working directory** before tool
> execution begins. »

> « **Self-hosted sandboxes don't support `resources` entries**; a session that includes any resource
> on a self-hosted environment **is rejected**. »

Et le tableau comparatif de la même page : *« File and GitHub repo mounting | Managed by Anthropic |
Managed by you »*.

**Le seul montage où CMA fournit un checkout git est donc le cloud**, via
`resources: [{ type: "github_repository", mount_path: … }]`. Le self-hosted n'en reçoit **aucun** —
c'est à l'opérateur de mettre les fichiers en place.

Ce qui survit de vrai, et qu'il faut écrire précisément : un opérateur qui lance le worker depuis son
checkout fait travailler l'agent sur le vrai working tree, parce que `--workdir` vaut `.` par défaut.
**C'est une capacité qu'il se donne en possédant l'hôte, pas une propriété de CMA** — et la doc
recommande l'inverse (`--workdir /workspace`, volume neuf par session).

#### B. 🔴 Et la prémisse était **hors sujet** de toute façon

Personne — ni cette fiche, ni `E01`, ni `E02` — n'avait vérifié dans le dépôt. Mesuré :

```
$ grep -cE "node:fs|child_process|execSync|simple-git" \
    src/conflict-detector.ts src/file-tracker.ts src/working-files-tracker.ts
0   0   0
```

**Aucun des trois modules ne touche un filesystem.** `detect()` compare des **chaînes** :
`params.target_files.filter((f) => threadFiles.includes(f))`. Et la clé de jointure est un **chemin
repo-relatif**, normalisé à l'arrivée — c'est écrit dans le schéma de `announce_work` :

> « Repo-relative file paths, forward-slash (e.g. 'src/foo.ts'). Normalized on arrival […] »

**Conséquence :** un agent CMA en sandbox **cloud**, monté en `/workspace/repo`, qui annonce
`src/foo.ts`, joint parfaitement l'annonce `src/foo.ts` d'un Claude Code local. Deux agents qui
éditent le même fichier dans deux clones du même dépôt **sont** en conflit — c'est une collision de
merge en préparation, c'est-à-dire le produit.

Ce qui dégrade réellement sans checkout local, c'est la couche de co-change git — dégradation **déjà
documentée** comme un mode de première classe (« team-mode, HTTP only »), pas une perte de sens.

#### C. 🔴 Deux fiches déjà livrées reposent sur cette erreur

- **`E01`** contenait le fait correct **et** l'a contredit dans le même fichier : elle liste
  « `github_repository` non supporté en sandbox self-hosted » parmi ses faits vérifiés, puis cite
  l'affirmation inverse de cette fiche comme un acquis.
- **`E02`** en a tiré son **verdict `refuser`**, avec la formule « le tunnel fabrique de la fausse
  coordination ». **Cette justification tombe.** Le verdict lui-même peut survivre sur K3 et K4 (coût
  et absence de demande), mais son argument principal doit être retiré.

#### D. K2 ne se déclenche pas — **sur la jambe mesurée**

`list_agents` avec 20 agents peuplés : **4 525 caractères**, soit 4,5 % du plafond de 100 000. Et CMA
plafonne à 20 agents par roster ; il en faudrait ~440.

**Réserve honnête :** §6.3 demandait aussi de mesurer les outils de `consultation-tools.ts`, que §5
désigne comme « candidat n°1 au dépassement » — un thread à N messages n'est pas borné par le plafond
de roster. **Je ne l'ai pas mesuré.** Dire « K2 ne se déclenche pas » tout court dépasserait ma mesure.

#### E. K3 se déclenche · K4 **ne se déclenche pas**, et §6.5 invente une doctrine

- **K3 :** le gabarit `sdk/` compte **22 fichiers** suivis. Seuil 8, franchi à 2,75×. Et le coût caché
  est pire : `sdk/` est `private`, absent de la chaîne de release, et le dépôt n'a **aucun**
  workspace multi-paquets. Un worker non publié est inutile — sa raison d'être est que l'opérateur
  l'installe. Ce n'est pas un fichier de plus, c'est un changement de topologie du dépôt.
- **K4 :** vérifié, `@anthropic-ai/sdk` n'est **aucune** dépendance aujourd'hui. Mais §6.5 s'appuie sur
  une doctrine « spec MCP uniquement » qui **n'existe nulle part** dans le dépôt — et le projet
  **consomme déjà** une API propriétaire d'Anthropic avec un header beta daté (`oauth-2025-04-20`,
  porté depuis ~16 mois). **L'argument de vendor lock-in de §6.5 est fabriqué.** Ce qui disqualifie la
  branche worker, c'est K3, pas la tenabilité de la dépendance.

#### F. §6.1 est mal posée **deux fois**, et §4 contredit §5

- **Alternative binaire alors qu'il y a trois chemins** : (b), les custom tools, est absent — alors
  que la fiche le documente en §1 et que `E01` l'a caractérisé « aucun endpoint, aucun tunnel ».
- **La question embarque sa réponse** : la subordonnée « seul montage où l'agent CMA partage le
  checkout » est la proposition fausse de §A, insérée comme un acquis. Une question qui contient sa
  prémisse ne se tranche pas, elle se ratifie.
- **§4 et §5 se contredisent** : §4 dit qu'un agent branché par (a) « est vu par `conflict-detector.ts`
  exactement comme un Claude Code local » ; §5 dit que ces modules sont « vides de sens » en sandbox
  cloud. **§4 a raison** (le code est déclaratif), §5 a tort.

#### G. Le fallback `?token=` est plus large que la fiche ne le dit

§0 le localise en `serve-http.ts` l. 328-330 — ce sont des **commentaires**. L'implémentation est dans
`authenticateRequest` (`src/auth.ts`), donc **partagée par toute route GET authentifiée** — y compris
**`GET /mcp`** sur session existante, c'est-à-dire la route exacte que la recette (a) demande
d'exposer. Ce n'est pas « sans intérêt pour CMA » : c'est un jeton en URL sur la route publiée.

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **Tout est en beta.** Les cinq briques dépendent de `managed-agents-2026-04-01` et du header `mcp-client-2025-11-20` — dont le prédécesseur `mcp-client-2025-04-04` est déjà déprécié après ~19 mois. Un paquet `cma-worker` publié sur npm hérite de ce rythme de rotation.
- **Vendor lock-in.** mcp-coordinator est aujourd'hui un serveur MCP conforme, utilisable par n'importe quel client. Un adaptateur CMA introduit une dépendance à `@anthropic-ai/sdk` et à une API propriétaire dans un projet qui a jusqu'ici tenu la ligne « spec MCP uniquement ».
- **Coût pour l'auto-hébergeur.** Le chemin (a) exige un endpoint HTTPS **publiquement joignable par Anthropic**. C'est l'inverse du profil de déploiement actuel (daemon localhost + broker MQTT local). Tunnel, certificat, rotation de token, surface d'attaque : c'est une décision d'exploitation, pas une case à cocher.
- **YAGNI.** Aucune demande utilisateur connue à ce jour. La valeur suppose des équipes faisant tourner des agents CMA sur le même repo que leurs Claude Code — un profil qu'on n'a pas observé.
- **Le chemin (c) est disproportionné.** Effort L, et la doc signale déjà deux trous : credentials `environment_variable` non supportés en self-hosted, et CLI `ant` seul insuffisant pour enregistrer une implémentation de custom tool. On construirait un pont sur des piles inachevées.
- **Le chemin (b) a un mode de panne silencieux.** Un custom tool déclaré mais non implémenté laisse la session bloquée en `requires_action` **indéfiniment** — pas de timeout. Sur 26 outils déclarés à la main, une erreur de nommage coûte une session gelée et facturée.
- **Duplication du catalogue.** (b) et (c) exigent de recopier 26 déclarations `name`/`description`/`input_schema` hors de `src/tools/`. Sans génération automatique, c'est une seconde source de vérité qui dérivera au premier ajout d'outil.

---

## 7. Décision

| | |
|---|---|
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ✅ **reporter** · ⬜ refuser |
| **Date** | 2026-08-16 |
| **Justification** | **K1 se déclenche : l'affirmation centrale de la fiche est réfutée par la documentation d'Anthropic** — « Anthropic doesn't mount files or GitHub repositories into self-hosted sandboxes », et `resources` y est **rejeté**. Le seul montage qui fournit un checkout est le **cloud**. K3 se déclenche aussi (22 fichiers de gabarit, plus une chaîne de publication multi-paquets inexistante). Et la recette (a) ne peut pas être documentée en l'état : elle demanderait d'exposer un daemon où un token `read` écrit (**#313**) et où un anonyme efface les `working_files` (**#330**). |
| **Issue / PR** | aucune ; **corrections à porter sur `E01` et `E02`** |
| **Jalon visé** | réveil sur fermeture de #313 et #330 |

### 🔴 Ce challenge invalide deux fiches déjà livrées

C'est le résultat le plus important, et il vaut plus que le verdict.

- **`E02` doit être rouverte.** Son verdict `refuser` s'appuie sur « le tunnel sert la sandbox cloud,
  où l'agent travaille sur une copie, donc où `conflict-detector` rendrait des verdicts **faux** ».
  **Cet argument est faux** : le détecteur ne touche aucun filesystem, il compare des chemins
  repo-relatifs. Deux clones du même dépôt qui éditent `src/foo.ts` **sont** en conflit. Le verdict
  peut survivre sur le coût et l'absence de demande — **pas sur cet argument**.
- **`E01` doit être annotée.** Elle contient le fait correct (`github_repository` non supporté en
  self-hosted) **et** cite l'affirmation inverse comme un acquis, dans le même fichier.

**La leçon dépasse ces trois fiches** : j'ai laissé une inférence non sourcée devenir un fait par
citation croisée. `E01` l'a citée, `E02` en a tiré un verdict, et aucune des deux n'est allée lire la
page. **Une fiche qui en cite une autre doit citer sa source, pas sa conclusion.**

### Ce qui est reporté, et à quelle condition

**Les trois chemins.** Condition de réveil : **#313 et #330 fermées**, plus une demande réelle.

Documenter la recette (a) aujourd'hui reviendrait à demander à un auto-hébergeur d'exposer un daemon
où le mode « lecture seule » n'a **aucun filet côté serveur** (#313 : le scope d'un service token est
validé au minting puis jeté) et où un client anonyme peut effacer les claims de fichiers d'un autre
agent (#330). « Zéro code » ne veut pas dire « zéro risque ».

### Ce qui est abandonné

**Le paquet `@mcp-coordinator/cma-worker`** (K3) — non pour la dépendance, qui est tenable, mais parce
qu'un paquet non publié est inutile et que le dépôt n'a pas de chaîne multi-paquets.

### Corrections obligatoires

- **§1(c), §4, §5, §6.1** : retirer « seul montage où l'agent CMA partage le checkout ». Le remplacer
  par le fait sourcé : *le cloud monte un dépôt via `resources` ; le self-hosted ne reçoit rien et
  c'est à l'opérateur de mettre les fichiers en place.*
- **§5 est faux** quand il dit que `conflict-detector` est « vide de sens » en sandbox cloud — **§4 a
  raison**, le code est déclaratif.
- **§6.5** : l'argument « le projet a tenu la ligne spec MCP uniquement » est **fabriqué** — le projet
  consomme déjà une API propriétaire Anthropic avec un header beta daté depuis 16 mois.
- **§6.1** : réécrire sans la prémisse fausse et **avec** le troisième chemin.
- **§0** : le fallback `?token=` n'est pas en `serve-http.ts` l. 328-330 (commentaires) mais dans
  `authenticateRequest`, et il couvre **`GET /mcp`**.

### Note de méthode — la faute la plus coûteuse de ce corpus

Les quatorze fiches précédentes m'ont repris sur des mesures incomplètes. Celle-ci est différente :
**j'ai propagé une affirmation non vérifiée à travers trois dossiers**, et elle a produit un verdict.

Le signal était pourtant visible : en §1(c), la phrase attribue explicitement à la doc le pattern
« wrap an MCP server as custom tools », **puis enchaîne le « seul montage » sans attribution**. Cette
rupture d'attribution dans une même phrase est exactement ce qu'il fallait voir — et je ne l'ai vue
qu'en pré-enregistrant le risque de circularité, c'est-à-dire par précaution de méthode, pas par
lecture attentive.

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : rate limits corrigés, forme de `configs` tranchée, ligne CORS corrigée, §5 vérifié fichier par fichier. |
| 2026-08-16 | **Challenge — verdict `reporter`, et invalidation de deux fiches déjà livrées.** **K1 déclenché** : l'affirmation « le chemin (c) est le seul montage où l'agent CMA partage le checkout git » est **réfutée par la doc d'Anthropic**, récupérée et citée — « Anthropic doesn't mount files or GitHub repositories into self-hosted sandboxes » et « Self-hosted sandboxes don't support `resources` entries; a session that includes any resource on a self-hosted environment is rejected ». **Le seul montage qui fournit un checkout est le cloud.** Et la prémisse était **hors sujet** : `conflict-detector.ts`, `file-tracker.ts` et `working-files-tracker.ts` ne contiennent **aucun** appel filesystem (mesuré : 0/0/0) — `detect()` compare des chaînes de chemins **repo-relatifs** normalisés à l'arrivée. Un agent cloud monté en `/workspace/repo` qui annonce `src/foo.ts` joint donc parfaitement un agent local. **Conséquence : `E02` doit être rouverte** — son verdict `refuser` reposait sur « le tunnel fabrique de la fausse coordination », argument faux ; **`E01` doit être annotée** — elle contient le fait correct et cite l'affirmation inverse dans le même fichier. K2 non déclenché **sur la jambe mesurée** (`list_agents` à 20 agents = 4 525 caractères, 4,5 % du plafond ; la jambe `consultation-tools` n'a pas été mesurée). K3 déclenché : gabarit `sdk/` = 22 fichiers, et aucune chaîne de publication multi-paquets. **K4 non déclenché** : la doctrine « spec MCP uniquement » de §6.5 est **fabriquée** — le projet consomme déjà une API propriétaire Anthropic avec un header beta daté depuis ~16 mois. §6.1 est mal posée deux fois (alternative binaire alors qu'il y a trois chemins ; prémisse fausse insérée dans l'énoncé), et §4 contredit §5 — §4 a raison. Réveil sur fermeture de **#313** et **#330**. |
