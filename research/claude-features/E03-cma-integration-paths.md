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
| **Statut du challenge** | ⬜ à faire |

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
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ⬜ reporter · ⬜ refuser |
| **Date** | |
| **Justification** | |
| **Issue / PR** | |
| **Jalon visé** | |

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : rate limits corrigés, forme de `configs` tranchée, ligne CORS corrigée, §5 vérifié fichier par fichier. |
