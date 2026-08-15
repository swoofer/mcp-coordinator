# C10 — Déploiement entreprise : managed-mcp.json, gateway, self-hosted runners

> **Gabarit de fiche.** Une fiche = une feature de la plateforme Claude/Anthropic.
> Les sections 1 à 5 sont remplies par la veille. Les sections 6 à 8 sont remplies
> **pendant le challenge** de la feature (une session dédiée par fiche).

| Champ | Valeur |
|---|---|
| **ID** | `enterprise-deployment` |
| **Surface** | claude-code |
| **Statut** | **mixte** : GA (managed-mcp, allow/deny lists, OAuth client, claude apps gateway, cross-session messaging) · **public beta** (self-hosted environments / runners) · **research preview** (channels) |
| **Disponible depuis** | managed-mcp / gateway : GA, non daté · `allowAllClaudeAiMcps` : v2.1.149+ · `claude mcp login` : v2.1.186 · retry 401 : v2.1.206 · fix redirect URI client pré-enregistré : v2.1.231 · self-hosted runners : v2.1.224 (7 août 2026), hooks serveur v2.1.229 (12 août 2026) |
| **Tier** | T2-fort-levier |
| **Nature** | integration |
| **Effort estimé** | M |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — runners et gateway hors de portée, managed-mcp testable |
| **Statut du challenge** | ⬜ à faire |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- **Statut élargi.** Les Channels (`channelsEnabled`, `allowedChannelPlugins`) sont en **research preview**, pas GA — la doc le dit explicitement en tête de `channels.md`. Le cross-session messaging (`crossSessionInbound`, `SendMessage`/`ListAgents`) est GA depuis v2.1.224. Ligne `Statut` corrigée en conséquence.
- **`src/auth.ts` : ligne 532 → 537.** La l. 532 est le commentaire `// Scenario (b)` ; le `WWW-Authenticate` du 401 est bâti l. 537 (`'Bearer realm="mcp-coordinator", error="invalid_token"'`), avec trois autres sites l. 565, 579, 589 et le helper `bearerAuthHeader(...)` l. 372/382/391/408/425. Corrigé en §4 et §5.
- **`pool` / `pool_id` recadré.** La doc de référence dit : les **séries de métriques et quelques champs d'API** conservent `pool` ; les flags CLI et variables d'environnement s'écrivent `environment` (`--environment-secret-file`), les orthographes `pool` étant dépréciées. L'ID a la forme `ccpool_...`. L'affirmation de la fiche sur « les claims de token » n'est pas soutenue par la page de référence.
- **`user.groups` est une chaîne séparée par des virgules**, pas une liste — précision ajoutée en §2, elle change le coût du point 3 de la §4.
- **Fait nouveau, décisif pour le challenge :** le cross-session messaging n'existe **pas sur Windows natif** (macOS et Linux seulement, WSL 2 inclus), ni sur Bedrock / Claude Platform on AWS / Google Agent Platform / Microsoft Foundry.

**Marqueurs `(à vérifier)` restants :** aucun. Le seul marqueur de la fiche (forme du bloc `mcpServers` dans `managed-mcp.json`) est **tranché** : le fichier utilise le même format qu'un `.mcp.json` de projet, `{ "mcpServers": { ... } }`, avec un exemple complet dans la doc ; un `{"mcpServers": {}}` vide désactive MCP entièrement. La réserve sur les noms de scopes (`coordinator.announce`…) reste valide telle qu'écrite : ce sont des noms maison, pas une API Anthropic.

Tout le reste de la §2 est confirmé mot pour mot contre la doc officielle : `allowManagedMcpServersOnly`, `allowAllClaudeAiMcps` (v2.1.149+), `disableClaudeAiConnectors`, `strictPluginOnlyCustomization`, `enabledMcpjsonServers`/`disabledMcpjsonServers`, `claude mcp reset-project-choices`, `OTEL_LOG_TOOL_DETAILS=1`, les trois formes de matcher et l'ordre d'évaluation (fusion → denylist → allowlist avec règle de type), les trois chemins d'installation, `claude gateway --config gateway.yaml`, `identity.source: gateway-oidc`, `user.groups`, tous les flags `claude self-hosted-runner` et `self-hosted-runner orchestrator`, `SELF_HOSTED_RUNNER_BG_RESULT_GRACE_MS`, `oauth.clientId|callbackPort|scopes|authServerMetadataUrl`, `--client-id`/`--client-secret`/`--callback-port`, `MCP_CLIENT_SECRET`, `headersHelper`, `claude mcp login <name>` (v2.1.186), `claude mcp add-json`, la découverte RFC 9728 **avant** RFC 8414, la primauté de `oauth.scopes`, `type: "ws"` (url/headers/headersHelper/timeout/alwaysLoad, auth par en-têtes uniquement) et la dépréciation de SSE. Tous les fichiers de la §5 existent et toutes les autres lignes citées pointent juste (`cli/init.ts:195`, `tests/unit/auth-routes.test.ts:161`, `src/database.ts:861-882`, `src/boot.ts:379-588`, `cli/doctor.ts` sonde RFC 8414). Les greps négatifs de la fiche sont confirmés : aucune occurrence de `managed-mcp`, `allowedMcpServers`, `self-hosted-runner` ni `claude gateway` dans le repo, et `/.well-known/oauth-protected-resource` n'est cité qu'en documentation d'absence (`README.md:361`, `audit/09-protocole-mcp.md`).

**Testabilité :** ⚠️ partielle

Testable ici : les deux premières puces du protocole (poser `C:\Program Files\ClaudeCode\managed-mcp.json` en admin, vérifier que `claude mcp add` sort bien `Cannot add MCP server: enterprise MCP configuration is active…`, puis jouer `allowedMcpServers` sur un port aléatoire de localhost), et la puce RFC 9728 (servir le document derrière un flag et observer l'ordre des requêtes de `claude mcp login`). La puce `headersHelper`/`ws` est déjà tranchée par la doc sans PoC : l'auth du transport `ws` est par en-têtes uniquement.

Non testable ici : tout le volet self-hosted runners (beta Team/Enterprise, à activer par un Owner sur `claude.ai/admin-settings/cloud-environments`, runners Linux/macOS seulement) et tout le volet gateway (`user.groups` / `identity.source` exigent un gateway déployé avec un IdP et un credential Bedrock/GCP/Foundry amont). Le comparatif « messaging natif vs MQTT » ne peut pas se faire sur l'hôte Windows : le cross-session messaging n'existe pas sur Windows natif — il faudrait deux conteneurs Linux sous Docker Desktop.

---

## 1. Ce que c'est

Trois surfaces distinctes qui décident si mcp-coordinator peut **exister** dans une org Claude Code, regroupées ici parce qu'elles se déploient ensemble.

**(a) Politique MCP administrateur.** `managed-mcp.json`, poussé par MDM/GPO dans `/Library/Application Support/ClaudeCode/`, `/etc/claude-code/` ou `C:\Program Files\ClaudeCode\`, prend le contrôle exclusif : seuls ses serveurs se chargent, `--mcp-config` et les serveurs de plugins sont supprimés, `claude mcp add` échoue. En dessous, `allowedMcpServers` / `deniedMcpServers` filtrent par `{ serverUrl }` (wildcards `*`, hôte insensible à la casse), `{ serverCommand }` (correspondance exacte argument par argument) ou `{ serverName }` — ce dernier n'étant **jamais** un contrôle de sécurité puisque l'utilisateur choisit le label. Ordre d'évaluation : fusion des sources, denylist, puis allowlist avec règle de type (un serveur distant doit matcher un `serverUrl` dès qu'il en existe un). Les settings sont lus managed > `--settings` > user, première valeur trouvée.

**(b) Claude apps gateway.** Service auto-hébergé embarqué dans le binaire `claude` (`claude gateway --config gateway.yaml`), intercalé entre les clients et le fournisseur de modèle (Bedrock, Claude Platform on AWS, Google Cloud, Microsoft Foundry). Les développeurs s'authentifient via l'IdP de l'entreprise ; le gateway détient le credential amont, applique les managed settings **par groupe IdP** et relaie l'OTLP. C'est lui qui pose `identity.source: "gateway-oidc"` et remplit `user.groups` dans la télémétrie — seule source d'identité de groupe IdP côté client.

**(c) Self-hosted environments.** Public beta Team/Enterprise, désactivé par défaut. Des runners tournent sur des hôtes du réseau interne, réclament des sessions cloud sur une queue, clonent le repo et lancent un process Claude Code enfant, jusqu'à `--capacity` sessions concurrentes. Trafic **sortant uniquement** vers api.anthropic.com. Un runner se verrouille sur le compte du premier utilisateur servi. Dans les champs d'API, les claims de token et les métriques, l'environnement s'appelle `pool` / `pool_id`.

Enfin, côté auth client, la surface OAuth de `.mcp.json` s'est étoffée : découverte RFC 9728 (`/.well-known/oauth-protected-resource`) **d'abord**, repli RFC 8414 (`/.well-known/oauth-authorization-server`) ensuite, `oauth.scopes` primant sur toute découverte.

## 2. Surface d'API exacte

```
# Politique admin
managed-mcp.json  (mcpServers)
allowedMcpServers / deniedMcpServers  → { serverUrl } | { serverCommand } | { serverName }
allowManagedMcpServersOnly: true
allowAllClaudeAiMcps: true            # v2.1.149+
disableClaudeAiConnectors
strictPluginOnlyCustomization: ["mcp"]
enabledMcpServers / disabledMcpServers          # opt-in/opt-out utilisateur
enabledMcpjsonServers / disabledMcpjsonServers  # approbation des serveurs de .mcp.json
claude mcp reset-project-choices
OTEL_LOG_TOOL_DETAILS=1

# Channels & messaging inter-sessions
channelsEnabled                       # master switch
allowedChannelPlugins: [{ "marketplace": ..., "plugin": ... }]
{"permissions":{"deny":["SendMessage","ListAgents"]},"crossSessionInbound":"refuse"}

# Gateway
claude gateway --config gateway.yaml
identity.source: "gateway-oidc"   |   user.groups     # attributs OTel

# Self-hosted runners
claude self-hosted-runner --environment-secret-file <path> --base-dir <path>
  --capacity --drain-grace-sec --retire-at <epoch-seconds> --release-idle-session-min
claude self-hosted-runner orchestrator
  --hook-concurrency --hook-timeout --expected-spawn-seconds --min-idle --scm-connector-host
env: SELF_HOSTED_RUNNER_BG_RESULT_GRACE_MS, HTTPS_PROXY, NO_PROXY
champs: pool, pool_id      |      claude --cloud --environment <name>
admin: « Allow self-hosted environments » (claude.ai/admin-settings/cloud-environments)

# OAuth client MCP (.mcp.json)
oauth.clientId | oauth.callbackPort | oauth.scopes | oauth.authServerMetadataUrl
--client-id --client-secret --callback-port | MCP_CLIENT_SECRET
headersHelper | claude mcp login <name> | claude mcp add-json
/.well-known/oauth-protected-resource  (RFC 9728, essayé en premier)
/.well-known/oauth-authorization-server (RFC 8414, repli)
WWW-Authenticate
type: "ws" (url, headers, headersHelper, timeout, alwaysLoad — pas d'OAuth) ; SSE déprécié
```

Entrée `allowedMcpServers` visée pour le daemon HTTP :

```json
{
  "allowedMcpServers": [{ "serverUrl": "https://coordinator.interne.example/mcp" }],
  "mcpServers": {
    "coordinator": {
      "type": "http",
      "url": "https://coordinator.interne.example/mcp",
      "oauth": { "scopes": "coordinator.announce coordinator.read" }
    }
  }
}
```

**Forme de `managed-mcp.json`** *(vérifié le 2026-08-14)* : le fichier « uses the same format as a project `.mcp.json` file », soit `{ "mcpServers": { "<nom>": { "type": "http", "url": … } } }` — mêmes entrées `stdio`/`http` avec `command`/`args`/`env`. Un `{ "mcpServers": {} }` vide désactive MCP entièrement. Les credentials ne doivent pas y aller (fichier lisible par tout utilisateur de la machine) : passer par `${VAR}`, OAuth, ou `headersHelper`.

*(réserve maintenue)* : les noms de scopes ci-dessus (`coordinator.announce`, `coordinator.read`) sont une proposition maison, pas une API Anthropic.

Précisions vérifiées : `user.groups` est une **chaîne séparée par des virgules**, pas une liste ; `allowManagedMcpServersOnly` et l'expansion `${VAR}` des entrées de politique exigent v2.1.219+ ; côté self-hosted, les flags CLI et variables d'environnement s'écrivent `environment`, seules les séries de métriques et quelques champs d'API gardent `pool` (`pool_id` de forme `ccpool_...`) ; le cross-session messaging exige v2.1.224+ et **n'existe pas sur Windows natif** (macOS/Linux, WSL 2 inclus).

## 3. Sources

- https://code.claude.com/docs/en/mcp
- https://code.claude.com/docs/en/managed-mcp
- https://code.claude.com/docs/en/channels
- https://code.claude.com/docs/en/cross-session-messaging
- https://code.claude.com/docs/en/claude-apps-gateway
- https://code.claude.com/docs/en/claude-apps-gateway-config
- https://code.claude.com/docs/en/self-hosted-environments
- https://code.claude.com/docs/en/feature-availability
- https://code.claude.com/docs/en/changelog
- https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :**

1. **Débloquer l'installation en org.** Aujourd'hui `mcp-coordinator init` imprime un snippet `{ "coordinator": { "type": "http", "url": ... } }` (`cli/init.ts:195`). Dans une org sous `managed-mcp.json`, ce snippet est purement et simplement ignoré : `--mcp-config` est supprimé et `claude mcp add` échoue. Livrable à coût quasi nul : un bloc `managed-mcp.json` prêt à l'emploi + une entrée `allowedMcpServers` de référence identifiée **par `serverUrl`** (le daemon HTTP), jamais par `serverName`. Sans ça, tout le travail Phase 2 (audit SHA-256, allowlists par org, 4 IdP) est invendable : rien ne s'installe.

2. **Conformité OAuth découvrable.** `src/discovery.ts` sert bien RFC 8414 (`buildDiscoveryDoc`, `handleDiscovery`), mais **rien** dans le repo ne sert `/.well-known/oauth-protected-resource` (grep : aucune occurrence). Or Claude Code essaie RFC 9728 **en premier**. Ajouter ce document et un `WWW-Authenticate` pointant vers l'authorization server rend le coordinateur auto-configurable ; le `WWW-Authenticate` existe déjà côté 401 (`src/auth.ts:537`, et l. 565/579/589, `tests/e2e/refresh-on-401.spec.ts`) mais n'annonce pas la ressource protégée.

3. **`user.groups` du gateway remplace du code maison.** Le projet fait aujourd'hui de l'allowlisting par org via des colonnes SQL dédiées (`orgs.allowlist_github_org`, `orgs.allowlist_idp_org_id`, `src/database.ts:861-882`, semées au boot `src/boot.ts:379-588`) plus un cache de membership (`src/auth/membership-cache.ts`). Si l'org passe par le gateway, l'identité de groupe IdP est déjà résolue et diffusée ; la capacité qui apparaît est un mapping groupe→org sans appel `/user/orgs`.

4. **Les self-hosted runners sont l'environnement où le broker traverse.** Deux sessions dans **deux conteneurs distincts** ne peuvent pas se joindre par le messaging natif (filesystem séparé) ; MQTT/HTTP traverse. Le Dockerfile et le docker-compose.yml existent déjà : la recette « coordinator sidecar pour self-hosted runners » est une doc, pas du code. La page « Customize sessions » documente explicitement la configuration de serveurs MCP et de hooks de cycle de vie par session.

5. **Un déni admin de `SendMessage`/`ListAgents` est une opportunité.** Une org qui coupe la coordination native pour raisons de sécurité a besoin d'une alternative auditable — le positionnement exact du projet.

**Risque si on ne fait rien :** un acheteur Team/Enterprise ne peut pas installer le produit, et l'échec est silencieux côté développeur (`claude mcp add` échoue sans dire pourquoi). Secondairement, `deniedMcpServers` par pattern d'URL peut bloquer un daemon en `http://localhost:*` si l'org a une règle large sur localhost — cas non documenté nulle part dans le repo.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `cli/init.ts` (l. 193-236, `--write-mcp-config`) | Le snippet produit est `type: "http"` sans bloc `oauth`. Ajouter `oauth.scopes` et un mode `--managed` qui imprime le bloc `managed-mcp.json` + l'entrée `allowedMcpServers` par `serverUrl`. |
| `src/discovery.ts` | Ne sert que RFC 8414. Ajouter `buildProtectedResourceDoc()` + handler `/.well-known/oauth-protected-resource` (RFC 9728), essayé en premier par Claude Code. |
| `src/serve-http.ts` | Câblage de la nouvelle route well-known (la route RFC 8414 est déjà câblée séparément, cf. `tests/unit/auth-routes.test.ts:161`). |
| `src/auth.ts` (l. 537, plus 565/579/589 et le helper `bearerAuthHeader` l. 372-425) | Le `WWW-Authenticate` sur 401 doit pointer vers la resource metadata pour compléter la chaîne RFC 9728. |
| `cli/doctor.ts` (l. 193-241, sonde `/.well-known/oauth-authorization-server`) | Ajouter une sonde RFC 9728 et une sonde « suis-je atteignable sous une politique managed » (URL publique stable, pas localhost). |
| `src/database.ts` (l. 861-882) · `src/boot.ts` (l. 379-588) · `src/auth/membership-cache.ts` | `allowlist_github_org` / `allowlist_idp_org_id` : point de branchement pour un mapping depuis `user.groups` fourni par le gateway. |
| `cli/channel.ts` (en-tête l. 1-20) | Serveur stdio des Channels : soumis à `channelsEnabled` (bloqué par défaut sur claude.ai Team/Enterprise) et à `allowedChannelPlugins`. Documenter l'entrée `{ marketplace, plugin }` requise. **Vérifié 2026-08-14 :** l'en-tête du fichier suppose `--channels mcp-coordinator` ; or pendant le research preview `--channels` n'accepte que des **plugins** (`--channels plugin:<nom>@<marketplace>`) issus de l'allowlist Anthropic ou de `allowedChannelPlugins`. Un serveur nommé nu ne s'enregistrerait pas. |
| `src/observability/metrics.ts` | Registry Prometheus (`prom-client`), servi sur `/metrics/auth`. Le gateway relaie de l'**OTLP** : écart de format à trancher si on veut consommer `user.groups` / `pool_id`. |
| `Dockerfile`, `docker-compose.yml` | Base de la recette « sidecar coordinateur pour self-hosted runner ». |
| `docs/onboarding-self-host.md`, `docs/idp-providers.md`, `README.md` | Aucune occurrence de `managed-mcp`, `allowedMcpServers`, `self-hosted-runner` ou `claude gateway` dans tout le repo (grep vérifié). C'est le trou de documentation. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Puisque `serverName` n'est pas un contrôle de sécurité et qu'un serveur distant doit matcher un `serverUrl` dès qu'une règle d'URL existe, faut-il faire du daemon HTTP à URL stable le **seul** profil supporté en org (et donc déclasser le mode local-first `http://localhost:<port>/mcp` de `cli/init.ts` en profil solo), ou maintenir deux profils avec deux entrées `allowedMcpServers` distinctes — `serverUrl` pour le daemon partagé, `serverCommand` exact pour le lancement local — au prix d'une matrice de support doublée ?

### 6.2 Hypothèse

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

<Comment on tranche : PoC, lecture de code, mesure, test avec un vrai client MCP, benchmark de tokens…
Le principe maison : on teste le vrai chemin de code, on ne théorise pas.>

> ⚠️ Non exécutable ici : les self-hosted runners (beta Team/Enterprise à activer par un Owner, hôtes Linux/macOS) et le gateway (`user.groups` / `identity.source` exigent un gateway déployé avec IdP et credential amont). Le comparatif messaging natif vs MQTT exige deux conteneurs Linux : le cross-session messaging n'existe pas sur Windows natif.

- [ ] Écrire un `managed-mcp.json` local (`C:\Program Files\ClaudeCode\`) déclarant le coordinateur, et vérifier que `claude mcp add` échoue bien et que le serveur managé se charge quand même.
- [ ] Avec `allowedMcpServers: [{ serverUrl: "http://localhost:*/mcp" }]`, vérifier si un daemon sur port aléatoire passe ou est bloqué — le mode par défaut du projet en dépend.
- [ ] Ajouter un `/.well-known/oauth-protected-resource` derrière un flag, lancer `claude mcp login coordinator` et lire les requêtes du client : RFC 9728 est-il réellement tenté avant RFC 8414 ?
- [ ] Lancer deux conteneurs Docker (image du projet + un faux runner) et mesurer si la coordination MQTT traverse là où le messaging natif échoue — c'est le seul trou réel que comble le broker.
- [ ] Vérifier si `headersHelper` suffit à authentifier le transport `ws` du broker sans implémenter OAuth côté websocket.

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **Le trou comblé par le broker sur les runners est plus étroit qu'annoncé.** Un vérificateur a explicitement corrigé cette fiche sur ce point : un runner exécute plusieurs sessions comme processus enfants sur le **même** hôte/conteneur jusqu'à `--capacity`, et la doc dit « two sessions inside the same container can still message each other, including on a self-hosted runner ». De plus un runner ne sert **qu'un seul utilisateur à la fois** (lock sur le compte à la première session) : le cas multi-sessions concurrentes est le cas nominal et il est **déjà couvert nativement**. Reste la coordination inter-runners / inter-conteneurs, ou sans dépendance au chemin Remote Control d'Anthropic. Un effort L pour ça est disproportionné.
- **Contradiction entre chercheurs sur l'effort et la confiance.** Deux fiches brutes décrivent les self-hosted environments : l'une donne `effort: L, confidence: medium` en disant la page docs non consultée, l'autre `effort: M, confidence: high` avec les 6 pages docs listées (`self-hosted-environments`, `-quickstart`, `-deploy`, `-configuration`, `-testing`, `-reference`, `-identity`). La seconde est la plus documentée ; la fiche retient M/high sans effacer le désaccord.
- **Vocabulaire non canonique.** « Fixed » / « On-demand » vient du CHANGELOG et du blog ; les docs disent « start runners yourself and keep them running » vs « on-demand runners » pilotés par l'« autoscaling orchestrator ». Ne pas figer ces termes dans notre doc.
- **Dépendance à une beta désactivée par défaut.** Les self-hosted environments sont en public beta au 2026-08-14, réservés Team/Enterprise, off by default, **indisponibles pour les orgs Zero Data Retention**, sans inférence via Bedrock / Google Agent Platform / Microsoft Foundry / LLM gateway, checkout GitHub uniquement, et Claude Tag / Claude Security / Code Review n'y routent pas encore. Construire une capacité produit dessus, c'est parier sur une surface qui exclut précisément les orgs les plus régulées — celles qui sont aussi le public de l'audit SHA-256.
- **Casse la portabilité hors Claude Code.** `managed-mcp.json`, `channelsEnabled`, `allowedChannelPlugins`, `crossSessionInbound` sont 100 % Claude Code. Le projet est un serveur MCP générique ; multiplier les chemins spécifiques à un client dilue cette promesse.
- **Complexité pour l'auto-hébergeur.** Le public actuel du projet est le solo/petite équipe qui lance `mcp-coordinator init`. Une doc entreprise qui parle de MDM, GPO, gateway OIDC et pools de runners n'aide personne de ce public et augmente la surface de maintenance des 8+ langues de `docs/index.html`.
- **YAGNI sur le gateway.** `user.groups` remplacerait `allowlist_idp_org_id`… seulement pour les orgs qui ont déployé le gateway. Les colonnes SQL et le membership cache restent nécessaires pour tous les autres : c'est un chemin **en plus**, pas un chemin **à la place**. Le bénéfice « du code disparaît » est faux ici.
- **Écart de format d'observabilité.** Le projet est Prometheus (`prom-client`, `/metrics` et `/metrics/auth`) ; le gateway relaie de l'OTLP. Consommer `pool_id` ou `user.groups` implique d'introduire une dépendance OpenTelemetry, pas de lire un champ.
- **Le vrai livrable est peut-être seulement de la doc.** Points 1, 4 et 5 de la §4 sont des pages de documentation et un exemple de compose — coût quasi nul. Seul le point 2 (RFC 9728) est du code. Le challenge doit résister à la tentation d'en faire un chantier.

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
| 2026-08-14 | Vérification des faits : API confirmée, marqueur tranché, `auth.ts` 532→537, channels research preview, messaging absent sur Windows. |
