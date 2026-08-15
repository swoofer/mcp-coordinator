# E02 — MCP tunnels : rendre le daemon privé joignable par les agents hébergés

| Champ | Valeur |
|---|---|
| **ID** | `mcp-tunnels` |
| **Surface** | claude-api · managed-agents |
| **Statut** | research-preview (à l'intérieur de la beta Managed Agents) |
| **Disponible depuis** | 2026-05-19 (research preview) ; API déplacée vers `/v1/tunnels` le 2026-06-22 |
| **Tier** | T2-fort-levier |
| **Nature** | opportunity |
| **Effort estimé** | M (L si on industrialise le setup WIF) |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — research preview sur formulaire, WIF requis pour la Tunnels API |
| **Statut du challenge** | ⬜ à faire |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- §2 — le marqueur `(à vérifier)` sur le corps de `POST /v1/tunnels` est tranché : le body n'a **qu'un seul champ, `display_name` (optionnel, string 1-255 ou null)** ; l'exemple officiel envoie `-d '{}'`. La réponse est un objet `BetaTunnel` `{ id (préfixe `tnl_`), archived_at, created_at, display_name, domain, type:"tunnel" }`.
- §4 — l'inférence « Managed Agents ne coordonne pas plusieurs agents entre eux » est **réfutée par la doc**, pas seulement dégradée en hypothèse : Managed Agents documente une orchestration multiagent (page `managed-agents/multiagent-orchestration`, événements `session.thread_created`, `agent.thread_message_sent` / `agent.thread_message_received`, `session.thread_status_*`, notion de coordinateur et de threads enfants). Le paragraphe a été réécrit en conséquence.
- §5 — `src/boot.ts` : la validation de `COORDINATOR_PUBLIC_URL` est en `validatePublicUrl()` lignes **512-534**, pas 517-561 (la plage citée englobait `warnOnInsecureCookiesFlag()`, qui est autre chose).
- §5 — `docker-compose.yml` : la ligne `image: ghcr.io/swoofer/mcp-coordinator:latest` est **commentée** (ligne 25) ; le service se construit par défaut depuis `build: { context: ., dockerfile: Dockerfile }`.

**Vérifié et exact (aucune correction) :** header `mcp-tunnels-2026-06-22`, `/v1/tunnels`, `POST /v1/tunnels/{tunnel_id}/certificates`, scope `workspace:manage_tunnels`, refus explicite des clés Admin API, surface dépréciée `/v1/organizations/tunnels` + `mcp-tunnels-2026-05-19` + `org:manage_tunnels` avec fenêtre de migration, `mcp-client-2025-11-20`, `managed-agents-2026-04-01`, exception `agent-memory-2026-07-22` sur `/v1/memory_stores`, `agent_toolset_20260401` et ses 8 outils (bash, read, write, edit, glob, grep, web_fetch, web_search), binaire `setup` dans l'image `mcp-proxy` avec `setup init` / `setup renew-cert`, `/etc/mcp-gateway/config.yaml` et l'intégralité des clés citées (`listen_addr`, `tunnel_domain`, `routes`, `tls.cert_file`/`tls.key_file`, `upstream.allowed_ips` défaut RFC1918, `upstream.disable_ip_validation`, `upstream.tls.ca_file`/`include_system_cas`), domaine `*.tunnel.anthropic.com`, edge `198.41.192.0/19` + `2606:4700:a0::/44` port 7844, path transmis tel quel. Statut **research preview** toujours exact au 2026-08-14 (Managed Agents est en beta ; tunnels et dreaming y sont en research preview sur demande d'accès). Tous les fichiers cités en §5 existent ; `src/serve-http.ts:1397` (`COORDINATOR_BIND`, défaut `127.0.0.1`), la route `/mcp` (ligne 740) sur `StreamableHTTPServerTransport`, `src/boot.ts:120`, `cli/doctor.ts:245-250` (`issuer` vs `base`) et `docker-compose.yml:35` (`COORDINATOR_BIND: "0.0.0.0"`) sont exacts.

**Marqueurs `(à vérifier)` restants :** aucun.

**Testabilité :** ⚠️ partielle
Ce qui se lance ici : la moitié « côté repo » du protocole — démarrer le daemon avec `COORDINATOR_PUBLIC_URL=https://<sub>.tunnel.anthropic.com` et `COORDINATOR_BIND` élargi, vérifier que `/.well-known/oauth-authorization-server` et `cli/doctor.ts` restent cohérents sur un host non-LAN, et rejouer le scénario 401/`WWW-Authenticate` puis service-token derrière un reverse proxy local qui simule le tunnel.
Ce qui bloque l'autre moitié : l'accès à la research preview passe par un formulaire de demande (`claude.com/form/claude-managed-agents`), et `POST /v1/tunnels` exige un bearer obtenu par Workload Identity Federation avec le scope `workspace:manage_tunnels` — les clés API/Admin sont explicitement refusées, donc ni tunnel réel, ni mesure de latence, ni appel Managed Agents de bout en bout sans un IdP OIDC enregistré et une federation rule.

## 1. Ce que c'est

Un mécanisme fourni par Anthropic pour rendre un serveur MCP tournant dans un réseau privé joignable par Claude, sans ouvrir de port entrant ni publier le service sur Internet. La pile tourne chez l'utilisateur : `cloudflared` en connexions **sortantes uniquement** (vers l'edge Cloudflare `198.41.192.0/19` et `2606:4700:a0::/44`, port 7844 TCP/UDP) plus un proxy Anthropic qui termine le TLS interne et route par hostname. Chaque serveur MCP exposé reçoit un hostname `<subdomain>.<tunnel-domain>` (domaine `*.tunnel.anthropic.com`), et le path est transmis tel quel au serveur amont — un serveur streamable-HTTP servant sur `/mcp` reste donc adressé sur `/mcp`.

Côté consommation, rien de spécifique au tunnel : on passe l'URL dans `mcp_servers` de la Messages API comme n'importe quel serveur MCP distant, ou on l'attache à une session Managed Agents depuis la Console (Sessions > + MCP Server, en fournissant Subdomain + Path). Le plan de contrôle est une API REST distincte, `/v1/tunnels`, avec son propre header beta et une authentification par Workload Identity Federation.

Quatre gardes de sécurité documentées : mTLS externe avec validation d'IP, TLS interne dont seul le client détient le certificat (Cloudflare ne peut pas lire les payloads), validation des IP amont côté proxy (`upstream.allowed_ips`, par défaut les plages RFC1918), et OAuth sur chaque serveur MCP. Point central pour nous : **le tunnel transporte le trafic chiffré jusqu'au serveur MCP mais ne s'authentifie PAS auprès de lui** — l'autorisation reste entièrement la responsabilité du serveur amont. Le déploiement se fait par Helm (Kubernetes) ou Docker Compose (VM). Fourni « as-is », sans engagement d'uptime, de support ni de continuité.

## 2. Surface d'API exacte

```
# Plan de contrôle (Tunnels API)
anthropic-beta: mcp-tunnels-2026-06-22
POST/GET /v1/tunnels
POST /v1/tunnels/{tunnel_id}/certificates
scope WIF : workspace:manage_tunnels          # clés Admin API REFUSÉES
(déprécié, fenêtre de migration : /v1/organizations/tunnels
 + mcp-tunnels-2026-05-19 + scope org:manage_tunnels)

# Consommation depuis la Messages API
anthropic-beta: mcp-client-2025-11-20

# Managed Agents (contexte)
anthropic-beta: managed-agents-2026-04-01
  (exception : les endpoints memory store utilisent agent-memory-2026-07-22)
toolset : agent_toolset_20260401

# Pile locale
binaire `setup` (setup init, setup renew-cert) dans l'image mcp-proxy
config proxy : /etc/mcp-gateway/config.yaml
  listen_addr, tunnel_domain, routes,
  tls.cert_file / tls.key_file,
  upstream.allowed_ips, upstream.disable_ip_validation,
  upstream.tls.ca_file / upstream.tls.include_system_cas
```

Payload minimal côté Messages API :

```json
{
  "mcp_servers": [
    { "type": "url",
      "url": "https://<subdomain>.<tunnel-domain>/mcp",
      "name": "mcp-coordinator",
      "authorization_token": "<jwt émis par mcp-coordinator>" }
  ],
  "tools": [
    { "type": "mcp_toolset", "mcp_server_name": "mcp-coordinator" }
  ]
}
```

Corps de `POST /v1/tunnels` (vérifié 2026-08-14) — un seul champ, optionnel :

```json
{ "display_name": "mcp-coordinator" }
```

`-d '{}'` est valide. Réponse : `BetaTunnel { id ("tnl_..."), archived_at, created_at, display_name, domain, type:"tunnel" }`. `domain` est le hostname assigné par Anthropic, globalement unique et jamais réutilisé. La création n'est **pas idempotente** et le tunnel refuse le trafic MCP tant qu'aucun certificat CA n'est enregistré.

**Divergences entre chercheurs, tranchées :** deux fiches brutes citaient le header de la Tunnels API simplement comme `mcp-tunnels` ; la doc officielle donne `mcp-tunnels-2026-06-22`, la forme `mcp-tunnels-2026-05-19` étant la version dépréciée (avec `/v1/organizations/tunnels` et le scope `org:manage_tunnels`). On retient la forme datée 2026-06-22.

## 3. Sources

- https://platform.claude.com/docs/en/agents-and-tools/mcp-tunnels/overview
- https://platform.claude.com/docs/en/managed-agents/overview
- https://platform.claude.com/docs/en/managed-agents/reference
- https://platform.claude.com/docs/en/api/beta-headers
- https://platform.claude.com/docs/en/release-notes/api
- https://platform.claude.com/docs/en/release-notes/overview

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :** c'est le chaînon manquant entre le positionnement actuel (« un daemon sur le réseau de l'équipe ») et les agents hébergés. Aujourd'hui `src/serve-http.ts` bind sur `127.0.0.1` par défaut (`COORDINATOR_BIND`) : le daemon est structurellement invisible depuis la Messages API et depuis Managed Agents. Avec un tunnel, un mcp-coordinator interne devient déclarable dans `mcp_servers` sans reverse proxy maison, sans certificat public, sans port entrant ni allowlist d'IP à négocier avec l'équipe réseau. Concrètement, ce n'est pas du code qui disparaît, c'est une capacité qui apparaît : la coordination multi-agents cesse d'être limitée aux agents locaux (Claude Code, SDK) et couvre les sessions Managed Agents.

Deuxième bénéfice, plus stratégique : le tunnel **ne s'authentifie pas** auprès du serveur amont. Toute la couche Phase 2 déjà en place — OAuth 2.1 (`src/auth/`), service tokens (`src/auth/service-tokens.ts`), allowlists (`src/auth/allowlist.ts`), quotas (`src/quota/`), audit chaîné SHA-256 (`src/security/audit-chain.ts`) — devient exactement la pièce manquante du dispositif, au lieu d'être un surcoût que l'auto-hébergeur subit. Le bénéficiaire est l'équipe qui veut faire tourner des agents hébergés contre un repo privé sans exposer quoi que ce soit.

**Risque si on ne fait rien :** faible à court terme, la fiche est une opportunité et non une menace. Le risque réel est un risque de positionnement : si l'on ne documente pas ce chemin, la réponse à « mcp-coordinator peut-il coordonner des agents Managed Agents ? » reste « non » par défaut, alors que le transport streamable-HTTP et l'auth nécessaires sont déjà là. Une inférence relevée par un chercheur — « Managed Agents ne coordonne pas plusieurs agents entre eux, donc le besoin reste entier » — a été **réfutée par la vérification du 2026-08-14** : Managed Agents documente une orchestration multiagent native (page `managed-agents/multiagent-orchestration`, événements `session.thread_created`, `agent.thread_message_sent` / `agent.thread_message_received`, `session.thread_status_running|idle|rescheduled|terminated`, avec un thread primaire jouant le rôle de coordinateur et des threads enfants). L'absence de tool de sous-agent dans `agent_toolset_20260401` (bash, read, write, edit, glob, grep, web_fetch, web_search) n'était qu'un indice, et il portait à faux : la coordination passe par les threads de session, pas par un outil. **Cet argument ne peut plus être utilisé en faveur de la fiche.**

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/serve-http.ts` | Bind par défaut `127.0.0.1` (`COORDINATOR_BIND`, ligne 1397) ; route `/mcp` (ligne 740) sur `StreamableHTTPServerTransport` (instancié ligne 801). Le proxy tunnel doit atteindre ce port : soit bind élargi, soit proxy colocalisé. La valeur par défaut de `upstream.allowed_ips` (RFC1918) ne couvre pas le loopback — à confronter au déploiement réel. |
| `src/boot.ts` | `COORDINATOR_PUBLIC_URL` est requis (ligne 120) et validé par `validatePublicUrl()` (lignes 512-534 : http:// non-localhost refusé sauf `COORDINATOR_INSECURE_COOKIES=true`). En mode tunnel, il doit valoir `https://<subdomain>.<tunnel-domain>` — sinon les URLs d'issuer et de redirect sont fausses. |
| `src/discovery.ts` | `/.well-known/oauth-authorization-server` dérive toutes ses URLs de `publicUrl`. Un client MCP passant par le tunnel doit obtenir des endpoints atteignables *depuis le tunnel*, pas depuis le LAN. |
| `src/auth/` (`service-tokens.ts`, `allowlist.ts`, `oauth-token.ts`, `jwt-mint.ts`) | Reste la seule couche d'autorisation. Le `authorization_token` de `mcp_servers[]` est un porteur opaque côté Anthropic : il faut décider quel type de credential on y met (service token long-vivant ? JWT court ?). |
| `src/security/audit-chain.ts`, `src/observability/metrics.ts` | Les appels arrivant par tunnel sont indiscernables des autres au niveau HTTP. Si on veut auditer « qui vient d'un agent hébergé », il faut un marqueur explicite. |
| `cli/doctor.ts` | Vérifie déjà `COORDINATOR_PUBLIC_URL` et compare `issuer` vs `base` (~ligne 250). Un check « tunnel » serait le prolongement naturel : joindre `https://<subdomain>.<tunnel-domain>/mcp` et vérifier que c'est bien notre daemon. |
| `docker-compose.yml` | Déjà `COORDINATOR_BIND: "0.0.0.0"` (ligne 35). Attention : la ligne `image: ghcr.io/swoofer/mcp-coordinator:latest` est **commentée** (ligne 25) — le service se construit par défaut depuis `build: { context: ., dockerfile: Dockerfile }`. Ajouter les services `cloudflared` + `mcp-proxy` ici est le plus court chemin vers un PoC. |
| `docs/operating-modes.md`, `docs/onboarding-self-host.md` | Un mode de déploiement supplémentaire à documenter (ou à refuser explicitement). |
| `sdk/src/client.ts`, `sdk/src/discovery.ts` | Non impactés fonctionnellement, mais le SDK est le point de comparaison : ce que fait le SDK en local, un agent hébergé le ferait via tunnel. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Le mode tunnel doit-il être un chemin de déploiement supporté (services `cloudflared` + `mcp-proxy` dans `docker-compose.yml`, check `doctor`, `COORDINATOR_PUBLIC_URL` documenté sur `<subdomain>.<tunnel-domain>`), ou reste-t-il une recette externe non versionnée, au motif qu'une research preview « as-is » ne peut pas porter une surface de support dans un projet auto-hébergé ?

### 6.2 Hypothèse

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

> ⚠️ Non exécutable ici : sans accès à la research preview (formulaire) ni bearer WIF avec le scope `workspace:manage_tunnels`, les étapes 1, 3, 4, 5 et 6 sont bloquées ; seule l'étape 2 (pile locale, cohérence `PUBLIC_URL`/discovery/doctor) est réalisable, et le 401 de l'étape 4 peut se rejouer derrière un reverse proxy local simulant le tunnel.

Proposition de protocole (non exécuté).

- [ ] Vérifier l'éligibilité : l'accès à la research preview passe par un formulaire de demande ; sans accès, la fiche s'arrête ici et devient « à surveiller ».
- [ ] Monter la pile en local via Docker Compose (`cloudflared` + image `mcp-proxy`, `setup init`), avec `COORDINATOR_BIND` réglé pour que le proxy atteigne le daemon, et confirmer que `upstream.allowed_ips` accepte l'adresse réellement utilisée.
- [ ] Appeler `POST /v1/tunnels` avec `anthropic-beta: mcp-tunnels-2026-06-22` et un bearer WIF (scope `workspace:manage_tunnels`) — mesurer le coût réel d'entrée : IdP OIDC enregistré + federation rule, sachant que les clés Admin API sont refusées.
- [ ] Depuis la Messages API, envoyer un message avec `mcp_servers[].url = https://<subdomain>.<tunnel-domain>/mcp` et `tools: [{type:"mcp_toolset"}]`, sans `authorization_token` d'abord : vérifier qu'on reçoit bien un 401 avec `WWW-Authenticate` de notre couche auth (preuve que le tunnel n'authentifie pas).
- [ ] Répéter avec un service token valide, faire appeler `announce` puis `status` par l'agent distant, et vérifier dans l'audit chaîné que les deux appels sont bien enregistrés et attribués.
- [ ] Mesurer la latence ajoutée par le tunnel sur un appel `status` par rapport au même appel en direct.

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **Research preview « as-is »**, sans engagement d'uptime, de support ni de continuité, et Anthropic peut l'arrêter. Documenter un mode de déploiement là-dessus, c'est promettre un chemin qu'on ne contrôle pas ; en cas d'arrêt, c'est nous qui recevons les issues.
- **Coût d'entrée non trivial** : les endpoints tunnels exigent un bearer obtenu par Workload Identity Federation avec le scope `workspace:manage_tunnels`, les clés Admin API étant explicitement refusées. Il faut donc un IdP OIDC enregistré et une federation rule. Pour un solo-mainteneur et pour l'auto-hébergeur typique du projet, c'est une marche haute — et ce n'est pas quelque chose qu'on peut tester en CI.
- **Trois processus de plus à faire tourner** (`cloudflared`, le proxy Anthropic, plus la gestion/renouvellement des certificats via `setup renew-cert`) pour un daemon qui tient aujourd'hui en un seul conteneur. Le pitch « un daemon, une commande » en souffre.
- **Dépendance à Cloudflare comme sous-traitant**, ce qui a des implications concrètes pour la page `docs/gdpr.md` et pour les déploiements qui choisissent l'auto-hébergement précisément pour éviter ce genre de chaîne. La doc note aussi qu'un attaquant détenant le tunnel token *et* une clé privée TLS peut usurper le proxy et lire les payloads MCP.
- **Débouché limité** : les tunnels créés en Console ne sont pas disponibles comme connecteurs dans `claude.ai`. Le public est API/Console, pas le produit grand public — et Managed Agents n'est éligible ni ZDR ni HIPAA BAA, ce qui exclut d'emblée une partie de la cible entreprise.
- **YAGNI** : aucun utilisateur n'a demandé à coordonner des agents Managed Agents. Le bénéfice repose sur une inférence non vérifiée (que Managed Agents ne coordonne pas ses propres sessions entre elles). Si cette inférence est fausse, le cas d'usage se réduit à « exposer le daemon » — problème qu'un tunnel générique (Cloudflare Tunnel, Tailscale, ngrok) résout déjà, sans header beta ni WIF.
- **Alternative moins couplée** : documenter un reverse proxy TLS standard devant `/mcp` couvre le même besoin pour les déploiements qui ont déjà une infra, avec zéro dépendance à une preview.

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
| 2026-08-14 | Vérification des faits : API confirmée, body `POST /v1/tunnels` tranché, inférence « pas de multiagent » réfutée, 2 lignes corrigées. |
