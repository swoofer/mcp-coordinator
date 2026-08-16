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
| **Statut du challenge** | ✅ **tranché** (2026-08-16) — `adopter partiellement` : 5 fichiers de doc ; RFC 9728 refusé ; gateway + runners à scinder |

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

*Pré-enregistrée le 2026-08-16, **avant** toute exécution.*

**Ce que je crois qu'il va se passer.**

1. **Le point qui décide de §6.1 est le matching de `serverUrl`.** Si le motif n'accepte pas de
   joker de port, alors le mode par défaut du projet — `http://localhost:<port aléatoire>/mcp`
   écrit par `cli/init.ts` — est **incompatible** avec toute org qui pose `allowedMcpServers`, et
   la question de §6.1 se tranche toute seule.
2. Ce matching est **lisible dans le binaire livré**, comme les quatre fiches précédentes.
3. Le volet self-hosted runners et le volet gateway resteront non exécutés — je le marquerai.
4. La puce `headersHelper`/`ws` est déjà tranchée par `C05` : l'outil `Monitor` n'a pas de
   `headers`, mais le **transport MCP `ws`**, lui, en a — ce sont deux surfaces distinctes que
   plusieurs fiches confondent.

**Verdict pressenti :** `reporter`, avec pour livrable la règle exacte de matching.

**Critères de mort.**

| # | Si… | …alors |
|---|---|---|
| **K1** | le matching de `serverUrl` n'est pas lisible dans le binaire **et** non testable ici | aucune preuve sur la question centrale → `reporter`, jamais `adopter`. |
| **K2** | un port aléatoire **passe** le motif d'URL | le mode local-first survit en org, §6.1 perd son tranchant, et je dois l'écrire. |
| **K3** | un port aléatoire est **bloqué** | le mode par défaut du projet est incompatible avec le profil org — c'est un fait de portabilité à documenter, indépendamment de toute adoption. |
| **K4** | `serverName` s'avère être un contrôle de sécurité (contre la prémisse de §6.1) | la question de §6.1 est mal posée et je dois la reformuler. |
| **K5** | le chantier dépasse **10 fichiers** | l'effort n'est plus M. |
| **K6** | aucun utilisateur en org n'a demandé ce profil | filtre YAGNI — mais, comme en `C07`, la friction d'installation est un problème constaté : à peser, pas à appliquer mécaniquement. |
| **K7** | le volet runners/gateway reste entièrement non exécuté | ces deux volets sortent du périmètre décidable : `reporter` nommément sur eux, quelle que soit la conclusion sur le reste. |

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

*Challenge du 2026-08-16. Claude Code **2.1.233**.*

> **Frontière exécuté / lu.** **Exécuté :** le matcher d'URL, extrait du binaire et **rejoué** sur
> une batterie de cas. **Lu :** la logique d'aiguillage de l'allowlist et la portée du contrôle
> exclusif. **Jamais exécuté :** tout le volet self-hosted runners et tout le volet gateway — voir
> §6.4-E, K7.

#### A. 🔴 §6.1 pose une question construite sur une prémisse fausse — **deux fois**

§6.1 demande s'il faut « déclasser le mode local-first `http://localhost:<port>/mcp` » parce qu'un
daemon sur port aléatoire ne matcherait pas une règle d'org. Les deux moitiés de cette prémisse sont
fausses.

**Première moitié : le port du projet n'est pas aléatoire.**

```
cli/config.ts:17        export const DEFAULT_HTTP_PORT = 3100;
src/serve-http.ts:80    const PORT = parseInt(process.env.PORT || "3100");
```

Le défaut est **fixe**. L'URL écrite par `cli/init.ts` est donc stable et prévisible.

**Seconde moitié : même un port aléatoire passerait.** Le matcher `mIn` a été extrait du binaire et
**réexécuté**. Extrait du mécanisme décisif, vérifié mot pour mot :

```js
if (!o && i.port !== r.port) return !1;
```

`o` est le drapeau « port joker ». Quand le motif contient `:*`, `new URL()` échoue (port non
numérique), le `catch` réécrit `:<token>` en `:0`, repasse, et **pose `o = true`** — après quoi
l'égalité de port **n'est jamais testée**. Résultats du rejeu :

```
pattern="http://localhost:*/mcp"     url="http://localhost:54321/mcp"   => true
pattern="http://localhost:*/mcp"     url="http://localhost:80/mcp"      => true
pattern="http://localhost:*/mcp"     url="http://localhost:54321/other" => false
pattern="http://localhost:8080/mcp"  url="http://localhost:54321/mcp"   => false
pattern="http://localhost/*"         url="http://localhost:54321/mcp"   => false   ← piège
pattern="http://127.0.0.1:*/mcp"     url="http://127.0.0.1:9999/mcp"    => true
```

**K2 se déclenche : le mode local-first survit en org.** La question de §6.1 n'a pas à être tranchée
— elle ne se pose pas.

> ⚠️ **Le seul piège réel, et il mérite d'être documenté :** un motif **sans port**
> (`http://localhost/*`) ne matche **pas** une cible qui en porte un. Un admin doit écrire `:*`
> explicitement. C'est le genre d'erreur qui produit un blocage incompréhensible.

#### B. `serverName` n'est pas un contrôle de sécurité — la prémisse de §6.1 était juste sur ce point

Le schéma impose **exactement un** des trois champs par entrée — vérifié :

```
Entry must have exactly one of "serverName", "serverCommand", or "serverUrl"
```

Et l'aiguillage est par **type de serveur**, avec priorité au champ correspondant : pour un serveur
distant, **dès qu'au moins une entrée `serverUrl` existe dans l'allowlist**, les entrées `serverName`
ne sont **jamais** consultées. Le nom ne « sauve » un serveur distant que si l'allowlist ne contient
aucune règle d'URL. Sur ce point la fiche avait raison.

Côté denylist, en revanche, le nom est OU-combiné **inconditionnellement** : nom exact, commande
exacte ou URL correspondante — l'un suffit à bloquer. Et la denylist est **prioritaire** sur
l'allowlist.

#### C. `serverCommand` : égalité **exacte** du tableau complet, aucun joker

```js
function HKo(e){ … return [t.command, ...t.args ?? []] }
function pQd(e,t){ if(e.length!==t.length)return!1; return e.every((r,n)=>r===t[n]) }
```

Description confirmée : « Command array `[command, ...args]` to match exactly ». Donc un profil org
qui autorise le lancement **local** doit figer la commande **et tous ses arguments**. C'est
beaucoup plus rigide que le profil URL — un argument de plus, et le serveur est refusé.

#### D. 🔴 Le « contrôle exclusif » est bien plus large que ce que dit §2

Le message que §2 cite (`Cannot add MCP server: enterprise MCP configuration is active and has
exclusive control over MCP servers`) n'apparaît que sur `claude mcp add`. Mais le **même prédicat**
gouverne tout le chargeur : quand une configuration MCP d'entreprise est présente, sont **ignorés**
le `.mcp.json` de projet, les scopes user et local, **les serveurs fournis par les plugins**,
`--mcp-config`, et les MCP déclarés en frontmatter d'agent. Seuls survivent les serveurs enterprise
filtrés par l'allowlist.

**Conséquence directe sur `C07` :** j'y ai conclu que le plugin est « nécessaire et suffisant » pour
qu'une org lève le verrou des channels. C'est vrai pour l'allowlist de channels — mais **dans une org
qui pose `managed-mcp.json`, les serveurs MCP fournis par les plugins sont ignorés**. Les deux
mécanismes ne se composent donc pas librement, et `C07` doit porter cette réserve.

Un second flag existe, absent de la fiche : `allowManagedMcpServersOnly`.

#### D bis. 🔴 Le seul item de **code** de la fiche rouvrirait une régression fermée

§4 point 2 propose d'ajouter `/.well-known/oauth-protected-resource` (RFC 9728) comme un simple
câblage qui « rend le coordinateur auto-configurable ». **Le dépôt dit le contraire, explicitement.**

`README.md` :

> « **MCP authorization spec discovery** : `/mcp` does not implement the MCP authorization spec's
> OAuth discovery flow — no `resource_metadata` (RFC 9728) … **This is a deliberate scope decision,
> not an oversight** … The coordinator is a **relying party, not an authorization server**: it signs
> users in to an IdP and has no authorization endpoint of its own, so **spec-compliant discovery is
> not a wiring job**. »

Et `src/discovery.ts` l. 25-33 le grave dans le code : `authorization_endpoint` **omis**,
`response_types_supported: []`, avec renvoi à l'**issue #307** — vérifiée **CLOSED**, intitulée
« Discovery : `authorization_endpoint` et `response_types_supported` annoncent un flux que
`/auth/login` n'honore pas ».

Autrement dit, le projet vient de **retirer** une annonce de flux OAuth parce qu'elle mentait. Un
document RFC 9728 pointerait vers ce même document RFC 8414, qui n'annonce plus d'endpoint
d'autorisation : un client conforme suivant la chaîne 9728 → 8414 aboutirait à un cul-de-sac.
**L'unique item de code de cette fiche rouvrirait la régression que #307 a fermée.**

#### D ter. Deux pièges de rédaction mesurés, que la fiche ne mentionne pas

Outre le motif sans port (§A), le rejeu du matcher en révèle deux autres :

```
BLOCKED  http://localhost:3100/mcp/      <=  http://localhost:*/mcp    ← barre oblique finale
BLOCKED  http://localhost:3100/mcp?x=1   <=  http://localhost:*/mcp    ← query string
BLOCKED  http://127.0.0.1:57231/mcp      <=  http://localhost:*/mcp    ← pas de résolution
```

**`127.0.0.1` ne matche pas `localhost`** : l'hostname est comparé littéralement, jamais résolu. Une
org qui écrit sa règle sur `localhost` bloque l'utilisateur qui a tapé `127.0.0.1`, et
réciproquement. Ces trois pièges valent plus, en pratique, que la question que pose §6.1.

#### E. K7 se déclenche : la moitié de la fiche n'est pas décidable ici

Les volets **self-hosted runners** (beta Team/Enterprise, activation par un Owner, hôtes Linux/macOS)
et **gateway** (`user.groups` / `identity.source`, exigent un gateway déployé avec IdP et credential
amont) n'ont donné lieu à **aucune exécution**, comme §0 l'annonçait. Ils sortent du périmètre
décidable de ce challenge, quelle que soit la conclusion sur le reste.

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
| **Verdict** | ⬜ adopter · ✅ **adopter partiellement** · ⬜ reporter · ⬜ refuser |
| **Date** | 2026-08-16 |
| **Justification** | **§6.1 pose une question sur un fait qui n'existe pas** : le port du projet est **fixe** (`DEFAULT_HTTP_PORT = 3100`), et même aléatoire il passerait — le joker `:*` court-circuite le test d'égalité de port, mesuré par rejeu du matcher. Il n'y a donc **rien à reporter** : il y a **une page à écrire** et deux tiers de fiche à scinder. Le seul item de code proposé (RFC 9728) **rouvrirait la régression fermée par #307** et doit être retiré du périmètre. |
| **Issue / PR** | aucune — le livrable est documentaire et tient en 5 fichiers |
| **Jalon visé** | prochaine passe de documentation |

### Ce qui est adopté — 5 fichiers, effort XS

Documenter le **profil org** dans la doc existante (`docs/onboarding-self-host.md`, `README.md`,
`docs/clients.md`, `docs/troubleshooting.md`, `CHANGELOG.md`) : un bloc `managed-mcp.json` d'exemple,
l'entrée littérale `serverUrl: "http://localhost:3100/mcp"`, et **les trois pièges mesurés** —

1. un motif **sans port** ne matche pas une cible qui en porte un : écrire `:*` explicitement ;
2. **barre oblique finale et query string cassent le match** ;
3. **`127.0.0.1` ne matche pas `localhost`** — l'hostname est comparé littéralement, jamais résolu.

S'y ajoute le fait de §6.4-D, absent de toute la doc du projet : quand une configuration MCP
d'entreprise est présente, le `.mcp.json` de projet, les scopes user et local, `--mcp-config` **et
les serveurs fournis par les plugins** sont ignorés. Un utilisateur en org qui suit le quickstart
actuel n'obtiendra rien, sans message exploitable.

> ⚠️ **K6 s'est déclenché et je passe outre — explicitement, pas en silence.** Aucun utilisateur en
> organisation n'existe : `enterprise`, `managed`, `gateway` → **0 issue chacun**. Je retiens quand
> même ce livrable pour trois raisons : le contenu est **déjà mesuré** et serait perdu autrement ;
> le coût est **XS** (5 fichiers, zéro ligne de code) ; et il documente un mode d'échec **silencieux**
> — exactement la classe de défaut que #328 vient de nous coûter. Si ces trois conditions n'étaient
> pas réunies, K6 imposerait `reporter`.

### Ce qui est refusé

**L'ajout de `/.well-known/oauth-protected-resource`** (§4 point 2), unique item de code de la fiche.
`README.md` qualifie son absence de « deliberate scope decision, not an oversight », `src/discovery.ts`
omet volontairement l'`authorization_endpoint`, et **#307 vient d'être fermée** pour avoir annoncé un
flux que `/auth/login` n'honore pas. Ajouter un document RFC 9728 pointant vers un RFC 8414 sans
endpoint d'autorisation enverrait un client conforme dans un cul-de-sac.

### Ce qui est scindé et reporté

**Les volets gateway et self-hosted runners.** K7 s'est déclenché — et il s'était déclenché **avant
la session** : §0 pré-enregistrait leur non-testabilité. Ils représentent pourtant 31 % de §2, deux
des cinq bénéfices de §4, un tiers de §5 et **six des neuf contre-arguments de §6.5**. Une seule
puce de §6.3 sur cinq a été réellement exécutée.

**Ces deux volets méritent leur propre fiche**, marquée `reporter`, avec pour condition de réveil la
sortie de beta des runners et l'existence d'un premier utilisateur en org. Les avoir agrafés à
`managed-mcp` « parce qu'ils se déploient ensemble » est une justification de rédacteur : ils ne se
**challengent** pas ensemble.

### Ce que le challenge invalide dans le reste du corpus

- **§4 point 5 ne survit pas à `C04`.** Il vend le bus MQTT comme « alternative auditable » à une org
  qui coupe la coordination native. Or **#330 est ouverte** : l'ACL du broker n'autorise que par
  préfixe d'org, et un client anonyme peut mettre un agent hors ligne et effacer ses `working_files`.
  Vendre « auditable » à un acheteur régulé pendant que #330 est ouverte est indéfendable.
- **Réserve à porter sur `C07`.** J'y concluais que le plugin est « nécessaire et suffisant » pour
  qu'une org lève le verrou des channels. C'est vrai de l'allowlist de channels, mais **dans une org
  qui pose `managed-mcp.json`, les serveurs MCP fournis par les plugins sont ignorés** (§6.4-D). Les
  deux mécanismes ne se composent pas librement.

### Note de méthode

Mon verdict projeté était `reporter`. Il était **trop généreux avec un chantier qui n'existe pas** :
on ne reporte pas une décision dont la prémisse est fausse, on constate qu'elle ne se pose pas.

Et mon critère **K7 était mal rangé** : §0 pré-enregistrait déjà la non-testabilité des deux tiers de
la fiche, donc K7 ne *pouvait pas* ne pas se déclencher. Un critère de mort qui est vrai avant
l'expérience n'est pas un critère : c'est une note de périmètre. La bonne réaction n'était pas de
l'adjuger en fin de course, mais de **scinder la fiche avant de commencer**.

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : API confirmée, marqueur tranché, `auth.ts` 532→537, channels research preview, messaging absent sur Windows. |
| 2026-08-16 | **Challenge — verdict `adopter partiellement`.** **§6.1 pose une question sur un fait qui n'existe pas** : le port est fixe (`DEFAULT_HTTP_PORT = 3100`), et le joker `:*` court-circuite de toute façon le test d'égalité de port (`if(!o&&i.port!==r.port)return!1`) — matcher extrait du binaire et **rejoué**. K2 déclenché. Trois pièges de rédaction mesurés, absents de la fiche : motif sans port, barre oblique finale / query string, et `127.0.0.1` ≠ `localhost` (hostname jamais résolu). Le « contrôle exclusif » est bien plus large que ne dit §2 : `.mcp.json` projet, scopes user/local, `--mcp-config`, frontmatter **et serveurs de plugins** sont ignorés. **Refusé : l'ajout de RFC 9728** (§4 point 2) — il rouvrirait la régression fermée par **#307**, `README.md` qualifiant son absence de « deliberate scope decision, not an oversight ». **K7 déclenché avant la session** (§0 pré-enregistrait la non-testabilité) : gateway + runners à scinder dans une fiche `reporter`. §4 point 5 ne survit pas à `C04` tant que **#330** est ouverte. Réserve à porter sur `C07` : dans une org à `managed-mcp.json`, les serveurs MCP des plugins sont ignorés. |
